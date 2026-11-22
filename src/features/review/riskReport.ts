import { z } from 'zod'

import { ReviewError } from './pr'
import { fetchPolicy, type Get, reviewAuthor } from './riskInputs'
import { parseRiskPolicy, RiskPolicyError, riskPolicyPath, sampleLabel } from './riskPolicy'
import { sampledMarker } from './riskSample'

export type ReportDeps = { get: Get; paginate: (path: string) => Promise<unknown[]> }

const pullsSchema = z.array(
  z.object({
    number: z.number(),
    state: z.string(),
    merged_at: z.string().nullable(),
    user: z.object({ login: z.string() }).nullable(),
    labels: z.array(z.object({ name: z.string() })).default([]),
  }),
)

type Pull = z.infer<typeof pullsSchema>[number]

const reviewsSchema = z.array(
  z.object({
    body: z.string(),
    state: z.string(),
    user: z.object({ login: z.string(), type: z.string() }).nullable(),
  }),
)

type Review = z.infer<typeof reviewsSchema>[number]

type Row = { pull: Pull; decision: string; approved: boolean; sampled: boolean; verdict: string | null }

const riskMarker = '\n\n## Risk\n'

async function labelFor(repo: string, deps: ReportDeps): Promise<{ label: string; note: string | null }> {
  const policy = await fetchPolicy(repo, deps)
  if (!policy) return { label: sampleLabel, note: `no ${riskPolicyPath} on the default branch, so risk review is off` }
  try {
    return { label: parseRiskPolicy(policy.text).sample.label, note: null }
  } catch (error) {
    if (!(error instanceof RiskPolicyError)) throw error
    return { label: sampleLabel, note: error.message }
  }
}

function riskSectionOf(reviews: Review[]): string | null {
  const body = reviews.findLast((review) => review.user?.login === reviewAuthor && review.body.includes(riskMarker))?.body
  return body ? body.slice(body.indexOf(riskMarker) + 2) : null
}

function humanVerdict(reviews: Review[], author: string | undefined): string {
  const human = reviews.filter((review) => review.user?.type === 'User' && review.user.login !== author)
  const verdict = human.findLast((review) => review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')
  if (verdict) return `${verdict.state === 'APPROVED' ? 'approved' : 'changes requested'} by ${verdict.user?.login}`
  return human.some((review) => review.state === 'COMMENTED') ? 'commented, no verdict yet' : 'pending'
}

function row(pull: Pull, reviews: Review[], label: string): Row | null {
  const section = riskSectionOf(reviews)
  if (!section) return null
  const decision = /^\*\*Decision:\*\* (.+)$/m.exec(section)?.[1]?.replaceAll('`', '') ?? 'unreadable decision'
  const sampled = pull.labels.some(({ name }) => name === label) || section.includes(sampledMarker)
  return {
    pull,
    decision,
    approved: decision.includes('approved by'),
    sampled,
    verdict: sampled ? humanVerdict(reviews, pull.user?.login) : null,
  }
}

function line({ pull, decision, verdict }: Row): string {
  const state = pull.merged_at ? 'merged' : pull.state
  return `  #${pull.number} ${state}: ${decision}${verdict ? ` · sampled: ${verdict}` : ''}`
}

function summary(repo: string, scanned: number, rows: Row[]): string {
  const approved = rows.filter((entry) => entry.approved).length
  const sampled = rows.filter((entry) => entry.sampled)
  const count = (prefix: string) => sampled.filter((entry) => entry.verdict?.startsWith(prefix)).length
  const verdicts = sampled.length
    ? ` (${count('approved')} approved, ${count('changes requested')} changes requested, ${sampled.length - count('approved') - count('changes requested')} without a verdict)`
    : ''
  return `${repo}: ${rows.length} of the ${scanned} most recently updated PRs have a risk decision; ${approved} auto-approved, ${sampled.length} sampled${verdicts}`
}

export async function riskReport(repo: string, limit: number, deps: ReportDeps): Promise<string> {
  const { label, note } = await labelFor(repo, deps)
  const pulls = pullsSchema.parse(await deps.get(`repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${limit}`))
  const rows = (
    await Promise.all(
      pulls.map(async (pull) =>
        row(pull, reviewsSchema.parse(await deps.paginate(`repos/${repo}/pulls/${pull.number}/reviews?per_page=100`)), label),
      ),
    )
  ).filter((entry) => entry !== null)
  return [summary(repo, pulls.length, rows), ...(note ? [`  note: ${note}`] : []), ...rows.map(line)].join('\n')
}

export async function runRiskReport(repos: string[], limit: number, out: (text: string) => void, deps: ReportDeps): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ReviewError('--limit must be a whole number from 1 to 100')
  const invalid = repos.find((repo) => !/^[\w.-]+\/[\w.-]+$/.test(repo))
  if (invalid) throw new ReviewError(`${invalid} is not an owner/repo; run in a GitHub repo or pass owner/repo`)
  for (const repo of repos) out(await riskReport(repo, limit, deps))
}
