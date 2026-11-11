import { appendFileSync, readFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

import { z } from 'zod'

import { approvedReviewContext, handOffApprovedReview } from './gateHandoff'
import { githubGet, githubPost, ReviewError } from './pr'

const eventSchema = z.object({
  action: z.string(),
  label: z.object({ name: z.string() }).optional(),
  sender: z.object({ login: z.string() }).optional(),
  pull_request: z.object({
    number: z.number(),
    head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
    user: z.object({ type: z.string() }),
    labels: z.array(z.object({ name: z.string() })).optional(),
  }),
})

const runsSchema = z.object({
  workflow_runs: z.array(z.object({ id: z.number(), run_number: z.number(), pull_requests: z.array(z.object({ number: z.number() })) })),
})

const jobsSchema = z.object({ jobs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })) })

const statusesSchema = z.array(
  z.object({ context: z.string(), state: z.string(), description: z.string().nullable(), target_url: z.string().nullable() }),
)

export type GateContext = {
  repo: string
  runId: string
  runNumber: number
  serverUrl: string
  eventName: 'pull_request' | 'pull_request_target'
  event: z.infer<typeof eventSchema>
}

export type GateDeps = {
  get: (path: string) => Promise<unknown>
  post: (path: string, body: unknown) => Promise<unknown>
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}

export type Verdict = { pass: boolean; message: string }

export const pollInterval = 30_000

const runsPerPage = 100

const rerunHint = 'Mark the PR as draft, then ready for review, to run the review again.'

const firstRunHint = 'Mark the PR as ready for review (from draft if it is not one) to run it.'

const forkHint =
  'The review does not run automatically on PRs from forks. A maintainer must read the diff, then add the `review` label to run it. If adding the label runs nothing, the caller workflow needs the `pull_request_target` `labeled` and `synchronize` triggers and the `actions: write` and `statuses: write` permissions; run `yoke review ci` to update it.'

const forkRerunHint = 'A maintainer must read the diff, then remove and add the `review` label again to re-run it.'

function verdict(conclusion: string, message: string): Verdict {
  const pass = conclusion === 'success'
  return { pass, message: pass ? message : `${message} ${rerunHint}` }
}

export function gateContext(env: NodeJS.ProcessEnv = process.env, command = 'yoke review gate'): GateContext {
  const { GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_NUMBER, GITHUB_SERVER_URL, GITHUB_EVENT_PATH, GITHUB_EVENT_NAME } = env
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GITHUB_RUN_NUMBER || !GITHUB_SERVER_URL || !GITHUB_EVENT_PATH || !GITHUB_EVENT_NAME) {
    throw new ReviewError(`${command} runs only in a GitHub Actions pull_request workflow`)
  }
  const event = eventSchema.safeParse(JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8')))
  if (!event.success || (GITHUB_EVENT_NAME !== 'pull_request' && GITHUB_EVENT_NAME !== 'pull_request_target'))
    throw new ReviewError(`${command} runs only on pull_request and pull_request_target events`)
  return {
    repo: GITHUB_REPOSITORY,
    runId: GITHUB_RUN_ID,
    runNumber: Number(GITHUB_RUN_NUMBER),
    serverUrl: GITHUB_SERVER_URL,
    eventName: GITHUB_EVENT_NAME,
    event: event.data,
  }
}

export async function earlierRuns({ repo, runId, runNumber, event }: GateContext, deps: Pick<GateDeps, 'get'>): Promise<number[]> {
  const { workflow_id } = z.object({ workflow_id: z.number() }).parse(await deps.get(`repos/${repo}/actions/runs/${runId}`))
  const workflowRuns: z.infer<typeof runsSchema>['workflow_runs'] = []
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      event: 'pull_request',
      branch: event.pull_request.head.ref,
      per_page: String(runsPerPage),
      page: String(page),
    })
    const { workflow_runs } = runsSchema.parse(await deps.get(`repos/${repo}/actions/workflows/${workflow_id}/runs?${query.toString()}`))
    workflowRuns.push(...workflow_runs)
    if (workflow_runs.length < runsPerPage) break
  }
  return workflowRuns
    .filter((run) => run.run_number < runNumber && run.pull_requests.some((pr) => pr.number === event.pull_request.number))
    .toSorted((a, b) => b.run_number - a.run_number)
    .map((run) => run.id)
}

export async function runJobs(repo: string, run: number, deps: Pick<GateDeps, 'get'>) {
  return jobsSchema.parse(await deps.get(`repos/${repo}/actions/runs/${run}/jobs`)).jobs
}

async function reviewJob(repo: string, run: number, deps: Pick<GateDeps, 'get'>) {
  return (await runJobs(repo, run, deps)).find((job) => job.name.endsWith(' / review'))
}

async function settledReview(repo: string, run: number, deps: GateDeps): Promise<string | undefined> {
  for (;;) {
    const review = await reviewJob(repo, run, deps)
    if (!review || review.conclusion === 'skipped') return undefined
    if (review.status === 'completed') return review.conclusion ?? 'unknown'
    deps.log(`Waiting for the review in run ${run} to finish (${review.status})`)
    await deps.sleep(pollInterval)
  }
}

async function forkVerdict({ repo, event }: GateContext, deps: GateDeps): Promise<Verdict> {
  const { sha } = event.pull_request.head
  const statuses = statusesSchema.parse(await deps.get(`repos/${repo}/commits/${sha}/statuses?per_page=100`))
  const approved = statuses.find((status) => status.context === approvedReviewContext)
  if (!approved) return { pass: false, message: forkHint }
  const where = approved.target_url ? `, in ${approved.target_url},` : ''
  const message = `The review a maintainer approved for ${sha.slice(0, 7)}${where} ${approved.description ?? `finished with ${approved.state}`}.`
  if (approved.state === 'pending') return { pass: false, message: `${message} The gate re-runs when it finishes.` }
  return approved.state === 'success' ? { pass: true, message } : { pass: false, message: `${message} ${forkRerunHint}` }
}

export async function reviewGate(reviewResult: string, context: GateContext, deps: GateDeps): Promise<Verdict> {
  if (context.eventName === 'pull_request_target') return handOffApprovedReview(reviewResult, context, deps)
  if (reviewResult !== 'skipped') return verdict(reviewResult, `The review on this event finished with ${reviewResult}.`)
  const { pull_request } = context.event
  if (pull_request.user.type === 'Bot') return verdict('success', 'No review runs for PRs from bots.')
  if (pull_request.head.repo?.full_name !== context.repo) return forkVerdict(context, deps)
  for (const run of await earlierRuns(context, deps)) {
    const conclusion = await settledReview(context.repo, run, deps)
    const url = `${context.serverUrl}/${context.repo}/actions/runs/${run}`
    if (conclusion) return verdict(conclusion, `The latest review for this PR, in run ${url}, finished with ${conclusion}.`)
  }
  return { pass: false, message: `No review has completed for this PR yet. ${firstRunHint}` }
}

export async function runReviewGate(reviewResult: string, out: (message: string) => void, env = process.env): Promise<boolean> {
  const deps = { get: (path: string) => githubGet(path), post: githubPost, sleep: (ms: number) => setTimeout(ms), log: out }
  const { pass, message } = await reviewGate(reviewResult, gateContext(env), deps)
  out(pass ? message : `::error::${message}`)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`)
  return pass
}
