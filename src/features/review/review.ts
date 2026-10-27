import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Settings } from '../config/settings'
import { formatSynthesis, parseSynthesis, type Synthesis } from './findings'
import { type HarnessRun, type RunHarness, runHarness } from './harness'
import { postFindings } from './post'
import { checkoutHead, fetchDiff, fetchPr, fetchPriorComments, github, ReviewError } from './pr'
import { assertViable } from './preflight'
import { buildReviewerPrompt, buildSynthesisPrompt } from './prompts'
import { buildRequest, type PullRequest } from './request'
import { type Reviewer, type ReviewSlots, resolveSlots, type Slot } from './slots'
import { type StatusUi, timed } from './status'

type Log = (line: string) => void

export type ReviewContext = { cwd: string; reviewDir: string; slots: ReviewSlots; runHarness: RunHarness } & Pick<StatusUi, 'log' | 'track'>

export type ReviewResult = { report: string; synthesis: Synthesis | null; markdown: string | null }

type Step = Pick<HarnessRun, 'prompt' | 'outputPath'> & { label: string; slot: Slot }

const reviewers: Reviewer[] = ['claude', 'codex']

function seconds(since: number): string {
  return `${Math.round((Date.now() - since) / 1000)}s`
}

function describeSlot({ harness, model, provider }: Slot): string {
  return model ? `${harness}:${provider ? `${provider}/` : ''}${model}` : harness
}

async function runStep({ label, slot, ...step }: Step, context: ReviewContext): Promise<boolean> {
  const started = Date.now()
  const status = context.track(label)
  const { harness, override } = slot
  const result = await context.runHarness({
    ...step,
    harness,
    override,
    cwd: context.cwd,
    reviewDir: context.reviewDir,
    onProgress: status.update,
  })
  if (result.ok) status.succeed(`${label} done in ${seconds(started)}`)
  else status.fail(`${label} failed after ${seconds(started)}: ${result.error}`)
  if (!result.ok) rmSync(step.outputPath, { force: true })
  return result.ok
}

function hasOutput(path: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8').trim().length > 0
}

async function runOrReuse(step: Step, context: ReviewContext): Promise<{ ok: boolean; ran: boolean }> {
  if (!hasOutput(step.outputPath)) return { ok: await runStep(step, context), ran: true }
  context.log(`${step.label}: cached`)
  return { ok: true, ran: false }
}

function reviewPath(context: ReviewContext, reviewer: Reviewer): string {
  return join(context.reviewDir, `${reviewer}.md`)
}

function reviewerLabel(reviewer: Reviewer, slot: Slot): string {
  return slot.model ? `${reviewer} reviewer (${describeSlot(slot)})` : `${reviewer} reviewer`
}

function synthesisResult(markdown: string): ReviewResult {
  const synthesis = parseSynthesis(markdown)
  if (!synthesis.summary && !synthesis.findings.length) return { report: markdown.trim(), synthesis: null, markdown: null }
  return { report: formatSynthesis(synthesis), synthesis, markdown }
}

function rawReviews(succeeded: Reviewer[], context: ReviewContext): ReviewResult {
  const report = succeeded
    .map((reviewer) => `# ${reviewer} review\n\n${readFileSync(reviewPath(context, reviewer), 'utf8').trim()}`)
    .join('\n\n')
  return { report, synthesis: null, markdown: null }
}

function synthesisSlot(succeeded: Reviewer[], context: ReviewContext): Slot {
  const [first = 'claude'] = succeeded
  return context.slots.synthesis ?? { harness: context.slots[first].harness }
}

async function synthesise(
  requestPath: string,
  succeeded: Reviewer[],
  reviewersRan: boolean,
  context: ReviewContext,
): Promise<ReviewResult> {
  const slot = synthesisSlot(succeeded, context)
  const outputPath = join(context.reviewDir, 'synthesis.md')
  if (reviewersRan) rmSync(outputPath, { force: true })
  const files = reviewers.map((reviewer) => ({ reviewer, path: succeeded.includes(reviewer) ? reviewPath(context, reviewer) : null }))
  const prompt = buildSynthesisPrompt(requestPath, files)
  if ((await runOrReuse({ label: `synthesis (${describeSlot(slot)})`, slot, prompt, outputPath }, context)).ok)
    return synthesisResult(readFileSync(outputPath, 'utf8'))
  context.log('showing the raw reviews instead')
  return rawReviews(succeeded, context)
}

export async function runReview(request: string, context: ReviewContext): Promise<ReviewResult> {
  const requestPath = join(context.reviewDir, 'request.md')
  writeFileSync(requestPath, request)
  const prompt = buildReviewerPrompt(requestPath)
  const results = await Promise.all(
    reviewers.map((reviewer) => {
      const slot = context.slots[reviewer]
      return runOrReuse({ label: reviewerLabel(reviewer, slot), slot, prompt, outputPath: reviewPath(context, reviewer) }, context)
    }),
  )
  const succeeded = reviewers.filter((_, i) => results[i]?.ok)
  if (!succeeded.length) throw new ReviewError('Every reviewer failed; nothing to report.')
  return synthesise(
    requestPath,
    succeeded,
    results.some((result) => result.ran),
    context,
  )
}

export function reviewRunDir(pr: PullRequest, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'yoke', 'reviews', `${pr.number}-${pr.headRefOid}`)
}

const cachedOutputs = ['claude.md', 'codex.md', 'synthesis.md', 'review.md']

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
      checkout.remove()
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
  { out, ui }: ReviewIo,
): Promise<void> {
  const { log } = ui
  const slots = resolveSlots(settings)
  const pr = await timed(ui, number ? `fetching PR #${number}` : "fetching this branch's PR", () => fetchPr(number))
  log(`#${pr.number} ${pr.title}`)
  const { diff, prior } = await timed(ui, 'fetching the diff and earlier review comments', () => ({
    diff: fetchDiff(pr),
    prior: fetchPriorComments(pr),
  }))
  const reviewDir = reviewRunDir(pr)
  prepareRunDir(reviewDir, force)
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
  await timed(ui, `posting to #${pr.number}`, () => postFindings(pr, findings, diff, prior, { api: github, log }))
}
