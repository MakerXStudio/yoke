import { findingMarker, hasMarker, type PriorComment } from './comments'
import { type Finding, formatLocation, type Synthesis } from './findings'
import type { ReviewComment } from './pr'
import { commentableLines } from './request'

export type PostPlan = { comments: ReviewComment[]; outside: Finding[]; skipped: Finding[] }

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
    else if (file && line !== null && lines.get(file)?.has(line)) plan.comments.push({ path: file, line, body: commentBody(finding) })
    else plan.outside.push(finding)
  }
  return plan
}

function outsideEntry(finding: Finding): string {
  const location = finding.file ? `\`${formatLocation(finding)}\`` : 'no location'
  const entry = [`- **${finding.severity ?? 'finding'}** ${location} — ${finding.title}`, ...details(finding).map((d) => `  ${d}`)]
  return [...entry, `  ${findingMarker(finding)}`].join('\n')
}

export function reviewBody(summary: string, outside: Finding[]): string {
  const sections = [summary || 'Adversarial review by Claude and Codex.']
  if (outside.length) sections.push(`### Findings outside the diff\n\n${outside.map(outsideEntry).join('\n')}`)
  return sections.join('\n\n')
}
