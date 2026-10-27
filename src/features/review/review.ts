import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Settings } from '../config/settings'
import type { PriorComment } from './comments'
import { formatSynthesis, parseSynthesis, type Synthesis } from './findings'
import { type HarnessRun, type RunHarness, runHarness } from './harness'
import { planPost, reviewBody } from './post'
import { checkoutHead, fetchDiff, fetchPr, fetchPriorComments, ReviewError, submitReview } from './pr'
import { buildReviewerPrompt, buildSynthesisPrompt } from './prompts'
import { buildRequest, type PullRequest } from './request'
import { type Reviewer, type ReviewSlots, resolveSlots, type Slot } from './slots'

type Log = (line: string) => void

export type ReviewContext = { cwd: string; reviewDir: string; slots: ReviewSlots; runHarness: RunHarness; log: Log }

export type ReviewResult = { report: string; synthesis: Synthesis | null; markdown: string | null }

type Step = Pick<HarnessRun, 'prompt' | 'outputPath'> & { label: string; slot: Slot }

const reviewers: Reviewer[] = ['claude', 'codex']

function seconds(since: number): string {
  return `${Math.round((Date.now() - since) / 1000)}s`
}

function describeSlot({ harness, model }: Slot): string {
  return model ? `${harness}:${model}` : harness
}

async function runStep({ label, slot, ...step }: Step, { log, ...context }: ReviewContext): Promise<boolean> {
  const started = Date.now()
  log(`${label} running…`)
  const { harness, override } = slot
  const result = await context.runHarness({ ...step, harness, override, cwd: context.cwd, reviewDir: context.reviewDir })
  log(result.ok ? `${label} done in ${seconds(started)}` : `${label} failed after ${seconds(started)}: ${result.error}`)
  return result.ok
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

async function synthesise(requestPath: string, succeeded: Reviewer[], context: ReviewContext): Promise<ReviewResult> {
  const slot = synthesisSlot(succeeded, context)
  const outputPath = join(context.reviewDir, 'synthesis.md')
  const files = reviewers.map((reviewer) => ({ reviewer, path: succeeded.includes(reviewer) ? reviewPath(context, reviewer) : null }))
  const prompt = buildSynthesisPrompt(requestPath, files)
  if (await runStep({ label: `synthesis (${describeSlot(slot)})`, slot, prompt, outputPath }, context))
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
      return runStep({ label: reviewerLabel(reviewer, slot), slot, prompt, outputPath: reviewPath(context, reviewer) }, context)
    }),
  )
  const succeeded = reviewers.filter((_, i) => results[i])
  if (!succeeded.length) throw new ReviewError('Every reviewer failed; nothing to report.')
  return synthesise(requestPath, succeeded, context)
}

export function savedReviewPath(pr: PullRequest, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'yoke', 'reviews', `${pr.number}-${pr.headRefOid}.md`)
}

async function reviewAtHead(pr: PullRequest, request: string, slots: ReviewSlots, log: Log): Promise<ReviewResult> {
  const reviewDir = mkdtempSync(join(tmpdir(), 'yoke-review-'))
  try {
    const checkout = checkoutHead(pr, reviewDir)
    try {
      return await runReview(request, { cwd: checkout.cwd, reviewDir, slots, runHarness, log })
    } finally {
      checkout.remove()
    }
  } finally {
    rmSync(reviewDir, { recursive: true, force: true })
  }
}

export type PostDeps = { submit: typeof submitReview; log: Log }

export function postFindings(pr: PullRequest, synthesis: Synthesis, diff: string, prior: PriorComment[], { submit, log }: PostDeps): void {
  const { comments, outside, skipped } = planPost(synthesis, diff, prior)
  if (skipped.length) log(`skipped ${skipped.length} finding(s) already raised on the PR`)
  if (!comments.length && !outside.length) return log('nothing new to post')
  const url = submit(pr, reviewBody(synthesis.summary, outside), comments)
  log(`posted ${comments.length} inline comment(s) and ${outside.length} in the review body: ${url}`)
}

export type ReviewOptions = { post: boolean }

export type ReviewIo = { out: Log; log: Log }

function savedReview(path: string, post: boolean): Synthesis | null {
  if (!post || !existsSync(path)) return null
  return parseSynthesis(readFileSync(path, 'utf8'))
}

function saveReview(path: string, markdown: string | null): void {
  if (!markdown) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, markdown)
}

export async function reviewPr(
  number: string | undefined,
  settings: Settings,
  { post }: ReviewOptions,
  { out, log }: ReviewIo,
): Promise<void> {
  const slots = resolveSlots(settings)
  const pr = fetchPr(number)
  const diff = fetchDiff(pr)
  const prior = fetchPriorComments(pr)
  const path = savedReviewPath(pr)
  let synthesis = savedReview(path, post)
  if (synthesis) {
    log(`posting the saved review of #${pr.number} at ${pr.headRefOid.slice(0, 7)}`)
    out(formatSynthesis(synthesis))
  } else {
    log(`reviewing #${pr.number} ${pr.title}`)
    const result = await reviewAtHead(pr, buildRequest(pr, diff, prior), slots, log)
    out(result.report)
    synthesis = result.synthesis
    saveReview(path, result.markdown)
  }
  if (!post) return
  if (!synthesis) throw new ReviewError('Not posting: the synthesis did not produce findings in the expected format.')
  postFindings(pr, synthesis, diff, prior, { submit: submitReview, log })
}
