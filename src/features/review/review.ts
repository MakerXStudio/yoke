import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Settings } from '../config/settings'
import { formatSynthesis, parseSynthesis, type Synthesis } from './findings'
import { runHarness } from './harness'
import { postFindings } from './post'
import { checkoutHead, fetchDiff, fetchPr, fetchPriorComments, github, ReviewError } from './pr'
import { assertViable } from './preflight'
import { buildRequest, type PullRequest } from './request'
import { logged, reviewLog } from './reviewLog'
import { type ReviewResult, runReview } from './run'
import { type ReviewSlots, resolveSlots } from './slots'
import { type StatusUi, timed } from './status'
import { modelsFooter, readUsedModels } from './usedModels'

type Log = (line: string) => void

export function reviewRunDir(pr: PullRequest, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const [, owner = '', repo = ''] = new URL(pr.url).pathname.split('/')
  const run = `${pr.number}-${pr.baseRefOid}-${pr.headRefOid}`
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'yoke', 'reviews', owner, repo, run)
}

const cachedOutputs = ['reviewer1.md', 'reviewer2.md', 'synthesis.md', 'review.md', 'models.json']

function prepareRunDir(reviewDir: string, force: boolean): void {
  mkdirSync(reviewDir, { recursive: true })
  if (force) for (const name of cachedOutputs) rmSync(join(reviewDir, name), { force: true })
}

async function reviewAtHead(pr: PullRequest, reviewDir: string, request: string, slots: ReviewSlots, ui: StatusUi): Promise<ReviewResult> {
  const checkoutDir = mkdtempSync(join(tmpdir(), 'yoke-review-'))
  try {
    const checkout = await timed(ui, `checking out ${pr.headRefOid.slice(0, 7)}`, () => checkoutHead(pr, checkoutDir))
    try {
      return await runReview(request, { cwd: checkout.cwd, reviewDir, slots, runHarness, log: ui.log, track: ui.track })
    } finally {
      await checkout.remove()
    }
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true })
  }
}

export type ReviewOptions = { post: boolean; force: boolean }

export type ReviewIo = { out: Log; ui: StatusUi }

function savedReview(path: string, post: boolean): Synthesis | null {
  if (!post || !existsSync(path)) return null
  return parseSynthesis(readFileSync(path, 'utf8'))
}

function saveReview(path: string, markdown: string | null): void {
  if (markdown) writeFileSync(path, markdown)
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
  const path = join(reviewDir, 'review.md')
  let synthesis = savedReview(path, post)
  if (synthesis) {
    log(`posting the saved review of #${pr.number} at ${pr.headRefOid.slice(0, 7)}`)
    out(formatSynthesis(synthesis))
  } else {
    await timed(ui, 'checking each reviewer can run', () => assertViable(slots))
    log(`review folder: ${reviewDir}`)
    const result = await reviewAtHead(pr, reviewDir, buildRequest(pr, diff, prior), slots, ui)
    out(result.report)
    synthesis = result.synthesis
    saveReview(path, result.markdown)
  }
  if (!post) return
  if (!synthesis) throw new ReviewError('Not posting: the synthesis did not produce findings in the expected format.')
  const findings = synthesis
  const footer = modelsFooter(readUsedModels(reviewDir))
  await timed(ui, `posting to #${pr.number}`, () => postFindings(pr, findings, diff, prior, { api: github, log, footer }))
}
