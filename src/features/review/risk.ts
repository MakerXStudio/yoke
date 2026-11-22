import { randomInt } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseSynthesis, type Synthesis } from './findings'
import { gateContext, type GateContext } from './gate'
import { githubGet, githubGraphql, githubPaginate, githubPost, githubPut, runAs } from './pr'
import { reviewRunDir } from './reviewRunDir'
import { type AuthorApi, type AuthorCheck, checkAuthor } from './riskAuthor'
import { type Decision, decide, riskSection, withRiskSection } from './riskDecision'
import { fetchPolicy, fetchPull, type Policy, type PostedReview, type PullInfo, rate, reviewAuthor } from './riskInputs'
import { type AppClient, enableMerge, withdraw } from './riskMerge'
import { riskPolicyPath, type RiskPolicy, withAiRating } from './riskPolicy'
import { sample } from './riskSample'

export type RiskDeps = {
  get: (path: string) => Promise<unknown>
  paginate: (path: string) => Promise<unknown[]>
  put: (path: string, body: unknown) => Promise<unknown>
  graphql: (query: string, variables: Record<string, string>) => Promise<unknown>
  app?: AppClient
  findings: (pull: PullInfo) => Synthesis | null
  log: (message: string) => void
  random: () => number
}

function evidence(head: string, policy: Policy, mode: string | undefined): string {
  return `Head: \`${head}\` · Policy: [\`${riskPolicyPath}\`](${policy.url}) at \`${policy.sha}\` on \`${policy.branch}\`${mode ? ` · Mode: \`${mode}\`` : ''}`
}

type Act = { repo: string; pull: PullInfo; reviews: PostedReview[]; policy: RiskPolicy | null; app: AppClient }

async function act(decision: Decision, approvalBody: string, { repo, pull, reviews, policy, app }: Act, deps: RiskDeps) {
  if (!decision.approved || !policy) return withdraw(repo, pull, reviews, app)
  await app.post(`repos/${repo}/pulls/${pull.number}/reviews`, { commit_id: pull.head.sha, event: 'APPROVE', body: approvalBody })
  deps.log(`Approved #${pull.number} at ${pull.head.sha} as ${app.login}.`)
  const sampled = await sample(repo, pull, policy, app, deps.random)
  return [...sampled, ...(policy.mode === 'merge' ? [await enableMerge(repo, pull, policy, app)] : [])]
}

function authorCheck(repo: string, pull: PullInfo, policy: RiskPolicy | null, deps: RiskDeps): Promise<AuthorCheck> {
  if (!policy) return Promise.resolve({ passed: false, outcome: 'not checked, the policy could not be read' })
  const api: AuthorApi = { get: deps.get, graphql: deps.graphql, orgGet: deps.app?.get }
  return checkAuthor(repo, pull.user, policy, api)
}

const unreviewed = (head: string) => ({
  because: 'this push was not reviewed',
  message: `${head} was pushed after the review and was not reviewed or rated, so it needs a human.`,
})

async function unreviewedPush(repo: string, pull: PullInfo, reviews: PostedReview[], app: AppClient | undefined): Promise<string> {
  const head = `#${pull.number} at ${pull.head.sha}`
  if (!app) return `${head} was not reviewed, and with no \`yoke-review\` App token nothing was withdrawn.`
  const actions = await withdraw(repo, pull, reviews, app, unreviewed(pull.head.sha))
  if (!actions.length) return `${head} was not reviewed, and \`${app.login}\` had no approval or auto-merge to withdraw.`
  return [`${head} was not reviewed, so it needs a human:`, ...actions.map((action) => `- ${action}`)].join('\n')
}

export async function riskReview(reviewResult: string, { repo, event }: GateContext, deps: RiskDeps): Promise<string> {
  const policyFile = await fetchPolicy(repo, deps)
  if (!policyFile) return `No ${riskPolicyPath} on the default branch, so risk review is off.`
  const { pull, files, reviews, posted } = await fetchPull(repo, event.pull_request.number, deps)
  if (reviewResult === 'skipped') return unreviewedPush(repo, pull, reviews, deps.app)
  const { policy, rating } = rate(policyFile.text, files, pull)
  const synthesis = posted ? deps.findings(pull) : null
  const decision = decide(withAiRating(rating, synthesis?.risk), {
    reviewResult,
    repo,
    pull,
    posted: !!posted,
    synthesis,
    hasApp: !!deps.app,
    author: await authorCheck(repo, pull, policy, deps),
  })
  const proof = evidence(pull.head.sha, policyFile, policy?.mode)
  const actions = deps.app ? await act(decision, riskSection(decision, proof), { repo, pull, reviews, policy, app: deps.app }, deps) : []
  const section = riskSection(decision, proof, actions)
  if (posted)
    await deps.put(`repos/${repo}/pulls/${pull.number}/reviews/${posted.id}`, {
      body: withRiskSection(posted.body, section),
    })
  else deps.log(`No review by ${reviewAuthor} was posted for ${pull.head.sha}, so the risk decision is only logged here.`)
  return section
}

type PullRef = {
  number: number
  html_url: string
  base: { sha: string }
  head: { sha: string }
}

export function cachedFindings(pull: PullRef): Synthesis | null {
  const dir = reviewRunDir({
    url: pull.html_url,
    number: pull.number,
    baseRefOid: pull.base.sha,
    headRefOid: pull.head.sha,
  })
  const path = join(dir, 'review.md')
  return existsSync(path) ? parseSynthesis(readFileSync(path, 'utf8')) : null
}

export function appClient(env: NodeJS.ProcessEnv): AppClient | undefined {
  const token = env.YOKE_REVIEW_APP_TOKEN
  if (!token) return undefined
  const exec = runAs(token)
  return {
    login: `${env.YOKE_REVIEW_APP_SLUG || 'yoke-review'}[bot]`,
    get: (path) => githubGet(path, exec),
    post: (path, body) => githubPost(path, body, exec),
    put: (path, body) => githubPut(path, body, exec),
    graphql: (query, variables) => githubGraphql(query, variables, exec),
  }
}

export async function runRiskReview(reviewResult: string, out: (message: string) => void, env = process.env): Promise<void> {
  const deps: RiskDeps = {
    get: (path) => githubGet(path),
    paginate: (path) => githubPaginate(path),
    put: (path, body) => githubPut(path, body),
    graphql: (query, variables) => githubGraphql(query, variables),
    app: appClient(env),
    findings: cachedFindings,
    log: out,
    random: () => randomInt(1_000_000) / 1_000_000,
  }
  out(await riskReview(reviewResult, gateContext(env, 'yoke review risk'), deps))
}
