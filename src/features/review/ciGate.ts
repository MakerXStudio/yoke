import { z } from 'zod'

import { callerWorkflowPath, gateCheck } from './ci'
import { checkCallerWorkflows } from './ciGateCaller'
import { githubGet, githubPost, ReviewError } from './pr'

const gateRuleset = {
  name: 'yoke review',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    {
      type: 'required_status_checks',
      parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: gateCheck }] },
    },
  ],
}

const recentPrCount = 20

const repoSchema = z.object({
  full_name: z.string(),
  html_url: z.string(),
  default_branch: z.string(),
  permissions: z.object({ admin: z.boolean() }).optional(),
})

type Repo = z.infer<typeof repoSchema>

const branchRulesSchema = z.array(
  z.object({
    type: z.string(),
    ruleset_id: z.number().optional(),
    parameters: z.object({ required_status_checks: z.array(z.object({ context: z.string() })).optional() }).optional(),
  }),
)

const directorySchema = z.array(z.object({ type: z.string(), name: z.string(), path: z.string() }))
const fileSchema = z.object({ content: z.string() })
const pullsSchema = z.array(z.object({ head: z.object({ sha: z.string() }) }))
const checkRunsSchema = z.object({ total_count: z.number() })
const createdSchema = z.object({ id: z.number() })

export type GateApi = {
  get: (path: string) => Promise<unknown>
  post: (path: string, body: unknown) => Promise<unknown>
}

const githubApi: GateApi = { get: (path) => githubGet(path), post: (path, body) => githubPost(path, body) }

export type GateOutcome = { created: boolean; message: string }

async function getUnlessMissing(api: GateApi, path: string): Promise<unknown> {
  try {
    return await api.get(path)
  } catch (error) {
    if (error instanceof ReviewError && error.message.includes('(HTTP 404)')) return undefined
    throw error
  }
}

async function workflowFiles(api: GateApi, repo: Repo): Promise<{ path: string; content: string }[]> {
  const ref = `ref=${encodeURIComponent(repo.default_branch)}`
  const listing = await getUnlessMissing(api, `repos/${repo.full_name}/contents/.github/workflows?${ref}`)
  if (listing === undefined) return []
  const files = directorySchema.parse(listing).filter((entry) => entry.type === 'file' && /\.ya?ml$/.test(entry.name))
  return Promise.all(
    files.map(async ({ path }) => {
      const { content } = fileSchema.parse(await api.get(`repos/${repo.full_name}/contents/${path}?${ref}`))
      return { path, content: Buffer.from(content, 'base64').toString('utf8') }
    }),
  )
}

async function callerProblem(api: GateApi, repo: Repo): Promise<string | undefined> {
  const branch = repo.default_branch
  const caller = checkCallerWorkflows(await workflowFiles(api, repo), repo.full_name, branch)
  if (!caller) return `No workflow on ${branch} calls yoke's review.yml. Run /review-ci, then merge its ${callerWorkflowPath} to ${branch}.`
  if (caller.problems.length > 0)
    return `${caller.path} on ${branch} calls yoke's review.yml but ${caller.problems.join(' and ')}. Fix it and merge the change to ${branch}.`
  return undefined
}

async function gateHasReported(api: GateApi, repo: Repo): Promise<boolean> {
  const pulls = pullsSchema.parse(
    await api.get(`repos/${repo.full_name}/pulls?state=all&sort=updated&direction=desc&per_page=${recentPrCount}`),
  )
  for (const { head } of pulls) {
    const runs = checkRunsSchema.parse(
      await api.get(`repos/${repo.full_name}/commits/${head.sha}/check-runs?check_name=${encodeURIComponent(gateCheck)}&per_page=1`),
    )
    if (runs.total_count > 0) return true
  }
  return false
}

async function problems(api: GateApi, repo: Repo): Promise<string[]> {
  const found: string[] = []
  if (!repo.permissions?.admin)
    found.push(
      `Your gh user can't manage ${repo.full_name}'s rulesets. Ask a repo admin to run \`yoke review-ci-gate\`, or to grant you the admin role.`,
    )
  const caller = await callerProblem(api, repo)
  if (caller) found.push(caller)
  if (!(await gateHasReported(api, repo)))
    found.push(
      `No ${gateCheck} check run on the ${recentPrCount} most recently updated PRs. Open or push to a PR so the gate reports, then run this again.`,
    )
  return found
}

export async function enforceReviewGate(api: GateApi = githubApi): Promise<GateOutcome> {
  const repo = repoSchema.parse(await api.get('repos/{owner}/{repo}'))
  const branch = repo.default_branch
  const rules = branchRulesSchema.parse(await api.get(`repos/${repo.full_name}/rules/branches/${encodeURIComponent(branch)}`))
  const existing = rules.find(
    (rule) =>
      rule.type === 'required_status_checks' && rule.parameters?.required_status_checks?.some((check) => check.context === gateCheck),
  )
  if (existing) {
    const where = existing.ruleset_id ? ` by ${repo.html_url}/rules/${existing.ruleset_id}` : ''
    return { created: false, message: `${gateCheck} is already required on ${branch}${where}; nothing changed.` }
  }
  const found = await problems(api, repo)
  if (found.length > 0)
    throw new ReviewError([`Cannot require ${gateCheck} on ${branch} yet:`, ...found.map((problem) => `- ${problem}`)].join('\n'))
  const { id } = createdSchema.parse(await api.post(`repos/${repo.full_name}/rulesets`, gateRuleset))
  return {
    created: true,
    message: `Added the "${gateRuleset.name}" ruleset, which blocks merging to ${branch} until ${gateCheck} passes: ${repo.html_url}/rules/${id}`,
  }
}
