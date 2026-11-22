import { ReviewError } from './pr'
import type { PullInfo } from './riskInputs'
import type { AppClient } from './riskMerge'
import type { RiskPolicy } from './riskPolicy'

export const sampledMarker = 'sampled for a human check'

const percent = (rate: number): string => `${Math.round(rate * 1000) / 10}%`

function failure(error: unknown): string {
  if (error instanceof ReviewError) return error.message
  throw error
}

function reviewerRequest(owner: string, reviewers: string[], author: string) {
  const people = reviewers.filter((entry) => !entry.includes('/') && entry.toLowerCase() !== author.toLowerCase())
  const teams = reviewers
    .filter((entry) => entry.includes('/'))
    .map((entry) => entry.split('/'))
    .filter(([org]) => org?.toLowerCase() === owner.toLowerCase())
    .map(([, slug = '']) => slug)
  return { reviewers: people, team_reviewers: teams }
}

async function attempt(done: string, failed: string, call: () => Promise<unknown>): Promise<string> {
  try {
    await call()
    return done
  } catch (error) {
    return `${failed}: ${failure(error)}`
  }
}

async function requestReviewers(repo: string, pull: PullInfo, reviewers: string[], app: AppClient): Promise<string> {
  const [owner = ''] = repo.split('/')
  const request = reviewerRequest(owner, reviewers, pull.user.login)
  const named = [...request.reviewers, ...request.team_reviewers.map((slug) => `${owner}/${slug}`)]
  if (!named.length) return 'no review requested: the policy names no `sample.reviewers` other than the author and teams outside the org'
  const list = named.map((name) => `\`${name}\``).join(', ')
  return attempt(`requested a review from ${list}`, `review from ${list} could not be requested`, () =>
    app.post(`repos/${repo}/pulls/${pull.number}/requested_reviewers`, request),
  )
}

export async function sample(repo: string, pull: PullInfo, policy: RiskPolicy, app: AppClient, random: () => number): Promise<string[]> {
  const { rate, reviewers, label } = policy.sample
  if (rate <= 0) return []
  if (pull.labels.some(({ name }) => name === label)) return [`already ${sampledMarker} (labelled \`${label}\`), so not sampled again`]
  if (random() >= rate) return []
  return [
    `${sampledMarker}, one of ${percent(rate)} of auto-approved PRs; a human can approve or request changes before or after merge`,
    await attempt(`labelled \`${label}\``, `the \`${label}\` label could not be added`, () =>
      app.post(`repos/${repo}/issues/${pull.number}/labels`, { labels: [label] }),
    ),
    await requestReviewers(repo, pull, reviewers, app),
  ]
}
