import { findingMarker, hasMarker, type PriorComment } from './comments'
import { type Finding, formatLocation, type Synthesis } from './findings'
import { type PendingReview, type ReviewApi, type ReviewComment, ReviewError } from './pr'
import { commentableLines, type PullRequest } from './request'

export type PostPlan = { comments: (ReviewComment & { finding: Finding })[]; outside: Finding[]; skipped: Finding[] }

function isAlreadyRaised(finding: Finding, prior: PriorComment[]): boolean {
  return finding.source === 'already-raised' || hasMarker(prior, findingMarker(finding))
}

const reviewerNames = /\b(?:the |a )?(?:claude|codex|opus|sonnet|haiku|gpt-[\w.-]+)\b/gi

export function withoutReviewerNames(text: string): string {
  return text.replace(reviewerNames, 'the reviewer')
}

function details(finding: Finding): string[] {
  return [
    ...(finding.impact ? [`Impact: ${withoutReviewerNames(finding.impact)}`] : []),
    ...(finding.recommendation ? [`Recommendation: ${withoutReviewerNames(finding.recommendation)}`] : []),
  ]
}

function title(finding: Finding): string {
  return withoutReviewerNames(finding.title)
}

function commentBody(finding: Finding): string {
  return [`**${finding.severity ?? 'finding'}: ${title(finding)}**`, ...details(finding), findingMarker(finding)].join('\n\n')
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
  const entry = [`- **${finding.severity ?? 'finding'}** ${location} — ${title(finding)}`, ...details(finding).map((d) => `  ${d}`)]
  return [...entry, `  ${findingMarker(finding)}`].join('\n')
}

export function reviewBody(summary: string, outside: Finding[], footer = ''): string {
  const sections = ['## Adversarial review', ...(summary ? [withoutReviewerNames(summary)] : [])]
  if (outside.length) sections.push(`### Findings outside the diff\n\n${outside.map(outsideEntry).join('\n')}`)
  if (footer) sections.push(footer)
  return sections.join('\n\n')
}

export type PostDeps = { api: ReviewApi; log: (line: string) => void; footer?: string }

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

export async function postFindings(
  pr: PullRequest,
  synthesis: Synthesis,
  diff: string,
  prior: PriorComment[],
  deps: PostDeps,
): Promise<void> {
  const { api, log } = deps
  const { comments, outside, skipped } = planPost(synthesis, diff, prior)
  if (skipped.length) log(`skipped ${skipped.length} finding(s) already raised on the PR`)
  if (!comments.length && !outside.length) return log('nothing new to post')
  const review = await api.open(pr)
  try {
    const rejected = await addComments(review, comments, deps)
    const url = await api.submit(pr, review, reviewBody(synthesis.summary, [...outside, ...rejected], deps.footer))
    log(`posted ${comments.length - rejected.length} inline comment(s) and ${outside.length + rejected.length} in the review body: ${url}`)
  } catch (error) {
    await api.discard(pr, review)
    throw error
  }
}
