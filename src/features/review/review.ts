import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Settings } from '../config/settings'
import { formatSynthesis, parseSynthesis, type Synthesis } from './findings'
import { runHarness } from './harness'
import { postFailure, postFindings } from './post'
import { checkoutHead, fetchDiff, fetchPr, fetchPriorComments, github } from './pr'
import { assertViable } from './preflight'
import { buildRequest, type PullRequest } from './request'
import { logged, reviewLog } from './reviewLog'
import { type ReviewResult, ReviewFailure, runReview } from './run'
import { type ReviewSlots, resolveSlots } from './slots'
import { type StatusUi, timed } from './status'
import { type StepUsage, writeJobSummary } from './usage'
import { modelsFooter, readUsedModels } from './usedModels'

type Log = (line: string) => void

export function reviewRunDir(pr: PullRequest, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const [, owner = '', repo = ''] = new URL(pr.url).pathname.split('/')
  const run = `${pr.number}-${pr.baseRefOid}-${pr.headRefOid}`
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'yoke', 'reviews', owner, repo, run)
}

const cachedOutputs = ['reviewer1.md', 'reviewer2.md', 'synthesis.md', 'review.md', 'models.json', 'slots.json']

function prepareRunDir(reviewDir: string, force: boolean): void {
  mkdirSync(reviewDir, { recursive: true })
  if (force) for (const name of cachedOutputs) rmSync(join(reviewDir, name), { force: true })
}

async function reviewAtHead(
  pr: PullRequest,
  reviewDir: string,
  request: string,
  slots: ReviewSlots,
  ui: StatusUi,
  strict: boolean,
): Promise<ReviewResult> {
  const checkoutDir = mkdtempSync(join(tmpdir(), 'yoke-review-'))
  try {
    const checkout = await timed(ui, `checking out ${pr.headRefOid.slice(0, 7)}`, () => checkoutHead(pr, checkoutDir))
    try {
      return await runReview(request, { cwd: checkout.cwd, reviewDir, slots, runHarness, log: ui.log, track: ui.track, strict })
    } finally {
      await checkout.remove()
    }
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true })
  }
}

export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_ACTIONS === 'true'
}

export function ciRunUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
}

export type ReviewOptions = { post: boolean; force: boolean }

export type ReviewIo = { out: Log; ui: StatusUi }

function savedReview(path: string, post: boolean): Synthesis | null {
  if (!post || !existsSync(path)) return null
  return parseSynthesis(readFileSync(path, 'utf8'))
}

export function saveReview(path: string, markdown: string | null): void {
  if (markdown) writeFileSync(path, markdown)
  else rmSync(path, { force: true })
}

export async function reviewPr(
  number: string | undefined,
  settings: Settings,
  { post, force }: ReviewOptions,
  io: ReviewIo,
): Promise<void> {
  const file = reviewLog()
  const ui = logged(io.ui, file.append)
  const out = (text: string) => {
    file.append(text)
    io.out(text)
  }
  const { log } = ui
  const slots = resolveSlots(settings)
  const pr = await timed(ui, number ? `fetching PR #${number}` : "fetching this branch's PR", () => fetchPr(number))
  log(`#${pr.number} ${pr.title}`)
  const [diff, prior] = await timed(ui, 'fetching the diff and earlier review comments', () =>
    Promise.all([fetchDiff(pr), fetchPriorComments(pr)]),
  )
  const reviewDir = reviewRunDir(pr)
  prepareRunDir(reviewDir, force)
  file.attach(reviewDir)
  const ci = post && isCi()
  const review = async (): Promise<{ synthesis: Synthesis | null; usage: StepUsage }> => {
    const path = join(reviewDir, 'review.md')
    const saved = savedReview(path, post)
    if (saved) {
      log(`posting the saved review of #${pr.number} at ${pr.headRefOid.slice(0, 7)}`)
      out(formatSynthesis(saved))
      return { synthesis: saved, usage: {} }
    }
    await timed(ui, 'checking each reviewer can run', () => assertViable(slots))
    log(`review folder: ${reviewDir}`)
    const result = await reviewAtHead(pr, reviewDir, buildRequest(pr, diff, prior), slots, ui, ci)
    out(result.report)
    saveReview(path, result.markdown)
    if (post && !result.synthesis)
      throw new ReviewFailure(
        'the synthesis could not be parsed',
        'Not posting: the synthesis did not produce findings in the expected format.',
      )
    return result
  }
  const footer = () => modelsFooter(readUsedModels(reviewDir))
  let findings: Synthesis | null
  try {
    const { synthesis, usage } = await review()
    findings = synthesis
    if (ci && synthesis && writeJobSummary(synthesis.summary, usage)) log('wrote the review summary and token usage to the job summary')
  } catch (error) {
    if (ci && error instanceof ReviewFailure) {
      const { reason } = error
      await timed(ui, `posting the failed review to #${pr.number}`, () =>
        postFailure(pr, reason, ciRunUrl(), { api: github, log, footer: footer() }),
      )
    }
    throw error
  }
  if (!post || !findings) return
  const synthesis = findings
  await timed(ui, `posting to #${pr.number}`, () => postFindings(pr, synthesis, diff, prior, { api: github, log, footer: footer(), ci }))
}
