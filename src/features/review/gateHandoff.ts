import { z } from 'zod'

import { approverRejection } from './approver'
import type { GateContext, GateDeps, Verdict } from './gate'

export const approvedReviewContext = 'review / approved review'

export const reviewLabel = 'review'

export const runPollInterval = 15_000

const runSchema = z.object({ id: z.number(), run_number: z.number(), status: z.string().nullable() })

const runsSchema = z.object({ workflow_runs: z.array(runSchema) })

const jobsSchema = z.object({ jobs: z.array(z.object({ id: z.number(), name: z.string() })) })

const statusesSchema = z.array(z.object({ context: z.string(), target_url: z.string().nullable() }))

const pendingResult = 'pending'

type ApprovalState = { state: string; description: string }

function approvalState(reviewResult: string): ApprovalState {
  if (reviewResult === pendingResult) return { state: 'pending', description: 'is running' }
  return { state: reviewResult === 'success' ? 'success' : 'failure', description: `finished with ${reviewResult}` }
}

async function postApproval(approval: ApprovalState, { repo, runId, serverUrl, event }: GateContext, deps: GateDeps): Promise<void> {
  await deps.post(`repos/${repo}/statuses/${event.pull_request.head.sha}`, {
    ...approval,
    context: approvedReviewContext,
    target_url: `${serverUrl}/${repo}/actions/runs/${runId}`,
  })
}

async function newerApprovalRun({ repo, runId, runNumber, event }: GateContext, deps: GateDeps): Promise<string | undefined> {
  const statuses = statusesSchema.parse(await deps.get(`repos/${repo}/commits/${event.pull_request.head.sha}/statuses?per_page=100`))
  const owner = statuses.find((status) => status.context === approvedReviewContext)?.target_url ?? ''
  const id = /\/actions\/runs\/(\d+)/.exec(owner)?.[1]
  if (!id || id === runId) return undefined
  const { run_number } = runSchema.parse(await deps.get(`repos/${repo}/actions/runs/${id}`))
  return run_number > runNumber ? owner : undefined
}

async function latestPullRequestRun({ repo, runId, event }: GateContext, deps: GateDeps) {
  const { workflow_id } = z.object({ workflow_id: z.number() }).parse(await deps.get(`repos/${repo}/actions/runs/${runId}`))
  const query = new URLSearchParams({ event: 'pull_request', head_sha: event.pull_request.head.sha, per_page: '100' })
  const { workflow_runs } = runsSchema.parse(await deps.get(`repos/${repo}/actions/workflows/${workflow_id}/runs?${query.toString()}`))
  return workflow_runs.toSorted((a, b) => b.run_number - a.run_number)[0]
}

async function settledRun(repo: string, id: number, status: string | null, deps: GateDeps): Promise<void> {
  while (status !== 'completed') {
    deps.log(`Waiting for run ${id} to finish (${status}) before re-running its gate`)
    await deps.sleep(runPollInterval)
    ;({ status } = runSchema.parse(await deps.get(`repos/${repo}/actions/runs/${id}`)))
  }
}

async function rerunHeadGate(context: GateContext, deps: GateDeps): Promise<string> {
  const { repo, serverUrl } = context
  const sha = context.event.pull_request.head.sha.slice(0, 7)
  const run = await latestPullRequestRun(context, deps)
  if (!run) return `No pull_request run of this workflow exists for ${sha}; its gate reads this result when it runs.`
  await settledRun(repo, run.id, run.status, deps)
  const { jobs } = jobsSchema.parse(await deps.get(`repos/${repo}/actions/runs/${run.id}/jobs`))
  const gate = jobs.find((job) => job.name.endsWith(' / gate'))
  const url = `${serverUrl}/${repo}/actions/runs/${run.id}`
  if (!gate) return `Run ${url} for ${sha} has no gate job to re-run; its gate reads this result when it runs.`
  await deps.post(`repos/${repo}/actions/jobs/${gate.id}/rerun`, {})
  return `Re-ran the gate for ${sha} in ${url}.`
}

export async function handOffApprovedReview(reviewResult: string, context: GateContext, deps: GateDeps): Promise<Verdict> {
  const { action, label } = context.event
  if (action !== 'labeled' || label?.name !== reviewLabel || reviewResult === 'skipped')
    return { pass: true, message: 'No approved review ran on this event.' }
  const rejection = await approverRejection(context, deps.get)
  const newer = await newerApprovalRun(context, deps)
  if (rejection) {
    if (newer) return { pass: false, message: `The review ${rejection}. A newer approved review, in ${newer}, owns the result.` }
    await postApproval({ state: 'failure', description: rejection }, context, deps)
    return { pass: false, message: `The review ${rejection}. ${await rerunHeadGate(context, deps)}` }
  }
  if (newer)
    return {
      pass: reviewResult === pendingResult || reviewResult === 'success',
      message: `A newer approved review, in ${newer}, owns the result for ${context.event.pull_request.head.sha.slice(0, 7)}, so this run's ${reviewResult} is not recorded.`,
    }
  await postApproval(approvalState(reviewResult), context, deps)
  const rerun = await rerunHeadGate(context, deps)
  if (reviewResult === pendingResult) return { pass: true, message: `Marked the review a maintainer approved as running. ${rerun}` }
  const pass = reviewResult === 'success'
  return { pass, message: `The review a maintainer approved finished with ${reviewResult}. ${rerun}` }
}
