import type { Synthesis } from './findings'
import type { AuthorCheck } from './riskAuthor'
import type { Rating } from './riskPolicy'

export type Gate = {
  reviewResult: string
  repo: string
  pull: {
    user: { login: string; type: string }
    head: { repo: { full_name: string } | null }
  }
  posted: boolean
  synthesis: Synthesis | null
  hasApp: boolean
  author: AuthorCheck
}

export type Decision = {
  approved: boolean
  rating: Rating
  blockers: string[]
  author: AuthorCheck
}

const riskHeading = '## Risk'

const noApp =
  'no `yoke-review` App token: the App is not configured (the `review-app-client-id` input and `YOKE_REVIEW_APP_PRIVATE_KEY` secret) or its token could not be created, so nothing is approved'

function reviewBlockers({ reviewResult, posted, synthesis }: Gate): string[] {
  if (reviewResult !== 'success') return [`the review finished with ${reviewResult}`]
  if (!posted) return ['no successful review was posted for the head commit']
  if (!synthesis) return ["the review's findings could not be read"]
  const serious = synthesis.findings.filter((finding) => finding.severity === 'blocker' || finding.severity === 'major').length
  return serious ? [`the review raised ${serious} blocker or major finding(s)`] : []
}

function authorBlockers({ repo, pull, author }: Gate): string[] {
  return [
    ...(pull.head.repo?.full_name === repo ? [] : ['the PR is from a fork']),
    ...(pull.user.type === 'Bot' ? [`the PR is from a bot (${pull.user.login})`] : []),
    ...(author.passed || pull.user.type === 'Bot' ? [] : ["the author's track record does not pass the policy"]),
  ]
}

export function decide(rating: Rating, gate: Gate): Decision {
  const { author } = gate
  if (rating.level !== 'low') return { approved: false, rating, blockers: [], author }
  const blockers = [...reviewBlockers(gate), ...authorBlockers(gate)]
  if (!blockers.length && !gate.hasApp) blockers.push(noApp)
  return { approved: !blockers.length, rating, blockers, author }
}

const bullets = (lines: string[]): string => lines.map((line) => `- ${line}`).join('\n')

export function riskSection({ approved, rating, blockers, author }: Decision, evidence: string, actions: string[] = []): string {
  const decision = approved ? 'low risk, approved by `yoke-review`' : `${rating.level} risk, needs a human`
  return [
    riskHeading,
    `**Decision:** ${decision}`,
    bullets([...rating.reasons, ...blockers]),
    `**Author:** ${author.outcome}`,
    ...(actions.length ? [`**Actions:**\n${bullets(actions)}`] : []),
    evidence,
  ].join('\n\n')
}

export function withRiskSection(body: string, section: string): string {
  const index = body.indexOf(`\n\n${riskHeading}\n`)
  return `${index === -1 ? body : body.slice(0, index)}\n\n${section}`
}
