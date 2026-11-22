import { z } from 'zod'

import { ReviewError } from './pr'
import type { PostedReview, PullInfo } from './riskInputs'
import type { RiskPolicy } from './riskPolicy'

export type AppClient = {
  login: string
  get: (path: string) => Promise<unknown>
  post: (path: string, body: unknown) => Promise<unknown>
  put: (path: string, body: unknown) => Promise<unknown>
  graphql: (query: string, variables: Record<string, string>) => Promise<unknown>
}

type MergeMethod = NonNullable<RiskPolicy['mergeMethod']>

const allowedMethods = [
  ['squash', 'allow_squash_merge'],
  ['merge', 'allow_merge_commit'],
  ['rebase', 'allow_rebase_merge'],
] as const

const repoSettingsSchema = z.object({
  allow_auto_merge: z.boolean().optional(),
  allow_squash_merge: z.boolean().optional(),
  allow_merge_commit: z.boolean().optional(),
  allow_rebase_merge: z.boolean().optional(),
})

const enableAutoMerge = `mutation($pr: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $pr, mergeMethod: $method, expectedHeadOid: $head}) { clientMutationId }
}`

const disableAutoMerge = `mutation($pr: ID!) {
  disablePullRequestAutoMerge(input: {pullRequestId: $pr}) { clientMutationId }
}`

function failure(error: unknown): string {
  if (error instanceof ReviewError) return error.message
  throw error
}

type MethodChoice = { method: MergeMethod; source: string } | { skipped: string }

async function chooseMethod(repo: string, policy: RiskPolicy, app: AppClient): Promise<MethodChoice> {
  const settings = repoSettingsSchema.parse(await app.get(`repos/${repo}`))
  if (settings.allow_auto_merge === false) return { skipped: 'the repo does not allow auto-merge (Settings → General → Allow auto-merge)' }
  if (policy.mergeMethod) return { method: policy.mergeMethod, source: 'from the policy' }
  const allowed = allowedMethods.find(([, setting]) => settings[setting])
  return allowed
    ? { method: allowed[0], source: 'the first the repo allows of squash, merge and rebase' }
    : { skipped: 'the repo reported no allowed merge method to the App' }
}

export async function enableMerge(repo: string, pull: PullInfo, policy: RiskPolicy, app: AppClient): Promise<string> {
  if (pull.auto_merge) return `auto-merge was already enabled by ${pull.auto_merge.enabled_by?.login ?? 'someone'}, so it was left as it is`
  try {
    const choice = await chooseMethod(repo, policy, app)
    if ('skipped' in choice) return `auto-merge is not enabled: ${choice.skipped}`
    await app.graphql(enableAutoMerge, { pr: pull.node_id, method: choice.method.toUpperCase(), head: pull.head.sha })
    return `auto-merge enabled as \`${app.login}\` with the \`${choice.method}\` method, ${choice.source}`
  } catch (error) {
    return `auto-merge could not be enabled: ${failure(error)}`
  }
}

export type Withdrawal = { because: string; message: string }

const noLongerLow = (head: string): Withdrawal => ({
  because: 'this head is no longer low risk',
  message: `${head} is no longer low risk; see the Risk section of the review on it.`,
})

async function dismiss(repo: string, pull: PullInfo, review: PostedReview, app: AppClient, why: Withdrawal): Promise<string> {
  const commit = review.commit_id ? `\`${review.commit_id}\`` : 'an earlier commit'
  try {
    await app.put(`repos/${repo}/pulls/${pull.number}/reviews/${review.id}/dismissals`, { event: 'DISMISS', message: why.message })
    return `dismissed the \`${app.login}\` approval of ${commit}, because ${why.because}`
  } catch (error) {
    return `the \`${app.login}\` approval of ${commit} could not be dismissed: ${failure(error)}`
  }
}

async function disable(pull: PullInfo, app: AppClient, why: Withdrawal): Promise<string[]> {
  if (pull.auto_merge?.enabled_by?.login !== app.login) return []
  try {
    await app.graphql(disableAutoMerge, { pr: pull.node_id })
    return [`disabled the auto-merge \`${app.login}\` enabled, because ${why.because}`]
  } catch (error) {
    return [`the auto-merge \`${app.login}\` enabled could not be disabled: ${failure(error)}`]
  }
}

export async function withdraw(
  repo: string,
  pull: PullInfo,
  reviews: PostedReview[],
  app: AppClient,
  why: Withdrawal = noLongerLow(pull.head.sha),
): Promise<string[]> {
  const approvals = reviews.filter((review) => review.user?.login === app.login && review.state === 'APPROVED')
  const dismissed: string[] = []
  for (const review of approvals) dismissed.push(await dismiss(repo, pull, review, app, why))
  return [...dismissed, ...(await disable(pull, app, why))]
}
