import { z } from 'zod'

import type { GateApi, Repo } from './ciGate'
import type { Caller } from './ciRiskCaller'
import type { Check, OwnedRepo } from './ciRiskCheck'
import type { RiskApi } from './ciRiskMerge'
import { reviewAuthor } from './riskInputs'

const appTokenStep = /^Get a yoke-review App token\b/
const appTokenLogGroup = '##[group]Run actions/create-github-app-token@'
const noAppMarker = 'no `yoke-review` App token'
const riskMarker = '\n\n## Risk\n'
const recentRuns = 10
const recentPrs = 20

const runsSchema = z.object({ workflow_runs: z.array(z.object({ id: z.number(), html_url: z.string() })) })
const jobsSchema = z.object({
  jobs: z.array(
    z.object({ id: z.number(), steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })).default([]) }),
  ),
})
const pullsSchema = z.array(z.object({ number: z.number(), html_url: z.string() }))
const reviewsSchema = z.array(z.object({ id: z.number(), body: z.string(), user: z.object({ login: z.string() }).nullable() }))

function tokenStepLogFailed(log: string): boolean {
  const lines = log.split('\n')
  const start = lines.findIndex((line) => line.includes(appTokenLogGroup))
  if (start === -1) return false
  const end = lines.findIndex((line, index) => index > start && /##\[group\]Run |Post job cleanup\./.test(line))
  return lines.slice(start, end === -1 ? undefined : end).some((line) => line.includes('##[error]'))
}

// The token steps run with continue-on-error, which reports a failed step's conclusion as success, so only the job log shows the failure.
async function tokenStepFailed(api: RiskApi, repo: Repo, jobId: number, conclusion: string | null): Promise<boolean> {
  if (conclusion !== 'success') return true
  return tokenStepLogFailed(await api.log(`repos/${repo.full_name}/actions/jobs/${jobId}/logs`))
}

export async function appCheck(api: RiskApi, repo: OwnedRepo, caller: Caller | undefined): Promise<Check> {
  const workflow = caller?.path.split('/').pop()
  const pending: Check = {
    name: 'App installed',
    passed: false,
    detail: `No review run has tried the yoke-review App token yet: ${repo.html_url}/actions. It runs once the workflow passes the App's client ID.`,
  }
  if (!workflow) return pending
  const { workflow_runs: runs } = runsSchema.parse(
    await api.get(`repos/${repo.full_name}/actions/workflows/${workflow}/runs?event=pull_request&per_page=${recentRuns}`),
  )
  for (const run of runs) {
    const { jobs } = jobsSchema.parse(await api.get(`repos/${repo.full_name}/actions/runs/${run.id}/jobs?per_page=100`))
    const tried = jobs.flatMap((job) =>
      job.steps
        .filter((step) => appTokenStep.test(step.name) && step.conclusion !== 'skipped' && step.conclusion !== null)
        .map((step) => ({ jobId: job.id, conclusion: step.conclusion })),
    )
    if (!tried.length) continue
    const failed = await Promise.all(tried.map(({ jobId, conclusion }) => tokenStepFailed(api, repo, jobId, conclusion)))
    if (!failed.some(Boolean)) return { name: 'App installed', passed: true, detail: `The App token step succeeded in ${run.html_url}` }
    const install =
      repo.owner.type === 'Organization'
        ? `https://github.com/organizations/${repo.owner.login}/settings/apps/yoke-review/installations`
        : 'https://github.com/settings/apps/yoke-review/installations'
    return {
      name: 'App installed',
      passed: false,
      detail: `The App token step failed in ${run.html_url}: the yoke-review App isn't installed on ${repo.full_name}. An org owner can install it at ${install}`,
    }
  }
  return pending
}

async function riskSection(api: GateApi, repo: Repo): Promise<{ url: string; section: string } | undefined> {
  const pulls = pullsSchema.parse(
    await api.get(`repos/${repo.full_name}/pulls?state=all&sort=updated&direction=desc&per_page=${recentPrs}`),
  )
  for (const pull of pulls) {
    const reviews = reviewsSchema.parse(await api.get(`repos/${repo.full_name}/pulls/${pull.number}/reviews?per_page=100`))
    const review = reviews.findLast((entry) => entry.user?.login === reviewAuthor && entry.body.includes(riskMarker))
    if (review)
      return { url: `${pull.html_url}#pullrequestreview-${review.id}`, section: review.body.slice(review.body.indexOf(riskMarker)) }
  }
  return undefined
}

export async function workingCheck(api: GateApi, repo: Repo): Promise<Check> {
  const found = await riskSection(api, repo)
  if (!found)
    return {
      name: 'Working',
      passed: false,
      detail: `No \`## Risk\` section on the ${recentPrs} most recently updated PRs: ${repo.html_url}/pulls. Once the setup is merged, open or push to a PR, then run this again.`,
    }
  if (found.section.includes(noAppMarker))
    return {
      name: 'Working',
      passed: false,
      detail: `The latest \`## Risk\` section was posted without the yoke-review App: ${found.url}. Fix the checks above, then push to a PR.`,
    }
  return { name: 'Working', passed: true, detail: `The latest \`## Risk\` section was posted with the App: ${found.url}` }
}
