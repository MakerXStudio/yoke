import { appendFileSync, readFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

import { z } from 'zod'

import { githubGet, ReviewError } from './pr'

const eventSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
    user: z.object({ type: z.string() }),
  }),
})

const runsSchema = z.object({
  workflow_runs: z.array(z.object({ id: z.number(), run_number: z.number(), pull_requests: z.array(z.object({ number: z.number() })) })),
})

const jobsSchema = z.object({ jobs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })) })

export type GateContext = {
  repo: string
  runId: string
  runNumber: number
  serverUrl: string
  event: z.infer<typeof eventSchema>
}

export type GateDeps = {
  get: (path: string) => Promise<unknown>
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}

export type Verdict = { pass: boolean; message: string }

export const pollInterval = 30_000

const rerunHint = 'Mark the PR as draft, then ready for review, to run the review again.'

const firstRunHint = 'Mark the PR as ready for review (from draft if it is not one) to run it.'

function verdict(conclusion: string, message: string): Verdict {
  const pass = conclusion === 'success'
  return { pass, message: pass ? message : `${message} ${rerunHint}` }
}

export function gateContext(env: NodeJS.ProcessEnv = process.env): GateContext {
  const { GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_NUMBER, GITHUB_SERVER_URL, GITHUB_EVENT_PATH } = env
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GITHUB_RUN_NUMBER || !GITHUB_SERVER_URL || !GITHUB_EVENT_PATH) {
    throw new ReviewError('yoke review-gate runs only in a GitHub Actions pull_request workflow')
  }
  const event = eventSchema.safeParse(JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8')))
  if (!event.success) throw new ReviewError('yoke review-gate runs only on pull_request events')
  return {
    repo: GITHUB_REPOSITORY,
    runId: GITHUB_RUN_ID,
    runNumber: Number(GITHUB_RUN_NUMBER),
    serverUrl: GITHUB_SERVER_URL,
    event: event.data,
  }
}

async function earlierRuns({ repo, runId, runNumber, event }: GateContext, deps: GateDeps): Promise<number[]> {
  const { workflow_id } = z.object({ workflow_id: z.number() }).parse(await deps.get(`repos/${repo}/actions/runs/${runId}`))
  const query = new URLSearchParams({ event: 'pull_request', branch: event.pull_request.head.ref, per_page: '100' })
  const { workflow_runs } = runsSchema.parse(await deps.get(`repos/${repo}/actions/workflows/${workflow_id}/runs?${query.toString()}`))
  return workflow_runs
    .filter((run) => run.run_number < runNumber && run.pull_requests.some((pr) => pr.number === event.pull_request.number))
    .toSorted((a, b) => b.run_number - a.run_number)
    .map((run) => run.id)
}

async function settledReview(repo: string, run: number, deps: GateDeps): Promise<string | undefined> {
  for (;;) {
    const { jobs } = jobsSchema.parse(await deps.get(`repos/${repo}/actions/runs/${run}/jobs`))
    const review = jobs.find((job) => job.name.endsWith(' / review'))
    if (!review || review.conclusion === 'skipped') return undefined
    if (review.status === 'completed') return review.conclusion ?? 'unknown'
    deps.log(`Waiting for the review in run ${run} to finish (${review.status})`)
    await deps.sleep(pollInterval)
  }
}

export async function reviewGate(reviewResult: string, context: GateContext, deps: GateDeps): Promise<Verdict> {
  if (reviewResult !== 'skipped') return verdict(reviewResult, `The review on this event finished with ${reviewResult}.`)
  const { pull_request } = context.event
  if (pull_request.head.repo?.full_name !== context.repo || pull_request.user.type === 'Bot') {
    return verdict('success', 'No review runs for PRs from forks or bots.')
  }
  for (const run of await earlierRuns(context, deps)) {
    const conclusion = await settledReview(context.repo, run, deps)
    const url = `${context.serverUrl}/${context.repo}/actions/runs/${run}`
    if (conclusion) return verdict(conclusion, `The latest review for this PR, in run ${url}, finished with ${conclusion}.`)
  }
  return { pass: false, message: `No review has completed for this PR yet. ${firstRunHint}` }
}

export async function runReviewGate(reviewResult: string, out: (message: string) => void, env = process.env): Promise<boolean> {
  const deps = { get: (path: string) => githubGet(path), sleep: (ms: number) => setTimeout(ms), log: out }
  const { pass, message } = await reviewGate(reviewResult, gateContext(env), deps)
  out(pass ? message : `::error::${message}`)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`)
  return pass
}
