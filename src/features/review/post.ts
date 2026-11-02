import { findingMarker, hasMarker, type PriorComment } from './comments'
import { type Finding, formatLocation, type Synthesis } from './findings'
import { type PendingReview, type ReviewApi, type ReviewComment, ReviewError } from './pr'
import { commentableLines, type PullRequest } from './request'

export type PostPlan = { comments: (ReviewComment & { finding: Finding })[]; outside: Finding[]; skipped: Finding[] }

function isAlreadyRaised(finding: Finding, prior: PriorComment[]): boolean {
  return finding.source === 'already-raised' || hasMarker(prior, findingMarker(finding))
}

function details(finding: Finding): string[] {
  return [
    ...(finding.impact ? [`Impact: ${finding.impact}`] : []),
    ...(finding.recommendation ? [`Recommendation: ${finding.recommendation}`] : []),
  ]
}

function commentBody(finding: Finding): string {
  return [`**${finding.severity ?? 'finding'}: ${finding.title}**`, ...details(finding), findingMarker(finding)].join('\n\n')
}

export function planPost({ findings }: Synthesis, diff: string, prior: PriorComment[]): PostPlan {
  const lines = commentableLines(diff)
  const plan: PostPlan = { comments: [], outside: [], skipped: [] }
  for (const finding of findings) {
    const { file, line } = finding
    if (isAlreadyRaised(finding, prior)) plan.skipped.push(finding)
    else if (file && line !== null && lines.get(file)?.has(line))
      plan.comments.push({ path: file, line, body: commentBody(finding), finding })
    else plan.outside.push(finding)
  }
  return plan
}

function outsideEntry(finding: Finding): string {
  const location = finding.file ? `\`${formatLocation(finding)}\`` : 'no location'
  const entry = [`- **${finding.severity ?? 'finding'}** ${location} — ${finding.title}`, ...details(finding).map((d) => `  ${d}`)]
  return [...entry, `  ${findingMarker(finding)}`].join('\n')
}

const noFindingsNote = 'No findings were raised.'

const rerunNote = 'To re-run this review, mark the PR as draft and then ready for review again.'

export function reviewBody(summary: string, outside: Finding[], footer = '', note = ''): string {
  const sections = ['## Adversarial review', ...(summary ? [summary] : []), ...(note ? [note] : [])]
  if (outside.length) sections.push(`### Findings outside the diff\n\n${outside.map(outsideEntry).join('\n')}`)
  if (footer) sections.push(footer)
  return sections.join('\n\n')
}

function postFooter(footer: string | undefined, ci: boolean): string {
  return [...(footer ? [footer] : []), ...(ci ? [`_${rerunNote}_`] : [])].join('\n\n')
}

export type PostDeps = { api: ReviewApi; log: (line: string) => void; footer?: string; ci?: boolean }

async function addComments(review: PendingReview, comments: PostPlan['comments'], { api, log }: PostDeps): Promise<Finding[]> {
  const rejected: Finding[] = []
  for (const { finding, ...comment } of comments) {
    try {
      await api.add(review, comment)
    } catch (error) {
      if (!(error instanceof ReviewError)) throw error
      rejected.push(finding)
      log(`GitHub rejected the comment on ${comment.path}:${comment.line}, so it goes in the review body: ${error.message}`)
    }
  }
  return rejected
}

export function failedReviewBody(reason: string, runUrl: string | undefined, footer = ''): string {
  const sections = ['## Code review failed', `The review did not complete: ${reason}. No findings were posted.`]
  if (runUrl) sections.push(`See the [workflow run](${runUrl}) for details.`)
  if (footer) sections.push(footer)
  return sections.join('\n\n')
}

export async function postFailure(pr: PullRequest, reason: string, runUrl: string | undefined, deps: PostDeps): Promise<void> {
  const review = await deps.api.open(pr)
  try {
    const url = await deps.api.submit(pr, review, failedReviewBody(reason, runUrl, postFooter(deps.footer, true)))
    deps.log(`posted the failed review: ${url}`)
  } catch (error) {
    await discard(pr, review, deps)
    throw error
  }
}

async function discard(pr: PullRequest, review: PendingReview, { api, log }: Pick<PostDeps, 'api' | 'log'>): Promise<void> {
  try {
    await api.discard(pr, review)
  } catch (discardError) {
    log(`could not discard the pending review: ${discardError instanceof Error ? discardError.message : String(discardError)}`)
  }
}

export async function postFindings(
  pr: PullRequest,
  synthesis: Synthesis,
  diff: string,
  prior: PriorComment[],
  deps: PostDeps,
): Promise<void> {
  const { api, log, ci = false } = deps
  const { comments, outside, skipped } = planPost(synthesis, diff, prior)
  if (skipped.length) log(`skipped ${skipped.length} finding(s) already raised on the PR`)
  const nothingNew = !comments.length && !outside.length
  if (nothingNew && !ci) return log('nothing new to post')
  const footer = postFooter(deps.footer, ci)
  const review = await api.open(pr)
  try {
    if (nothingNew) {
      const url = await api.submit(pr, review, reviewBody(synthesis.summary, [], footer, noFindingsNote))
      return log(`nothing new to post, so posted a review without findings: ${url}`)
    }
    const rejected = await addComments(review, comments, deps)
    const url = await api.submit(pr, review, reviewBody(synthesis.summary, [...outside, ...rejected], footer))
    log(`posted ${comments.length - rejected.length} inline comment(s) and ${outside.length + rejected.length} in the review body: ${url}`)
  } catch (error) {
    await discard(pr, review, deps)
    throw error
  }
}
