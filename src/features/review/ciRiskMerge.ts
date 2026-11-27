import { z } from 'zod'

import type { GateApi, Repo } from './ciGate'
import type { Check } from './ciRiskCheck'
import { ReviewError } from './pr'

export type RiskApi = GateApi & {
  patch: (path: string, body: unknown) => Promise<unknown>
  log: (path: string) => Promise<string>
}

const approvalRuleset = {
  name: 'yoke risk',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
  ],
}

const autoMergeSchema = z.object({ allow_auto_merge: z.boolean().optional() })
const pullRequestRulesSchema = z.array(
  z.object({
    type: z.string(),
    ruleset_id: z.number().optional(),
    parameters: z
      .object({ required_approving_review_count: z.number().optional(), dismiss_stale_reviews_on_push: z.boolean().optional() })
      .optional(),
  }),
)
const classicSchema = z.object({
  required_pull_request_reviews: z
    .object({ required_approving_review_count: z.number().optional(), dismiss_stale_reviews: z.boolean().optional() })
    .optional(),
})
const rulesetsSchema = z.array(z.object({ id: z.number(), name: z.string(), enforcement: z.string() }))
const createdSchema = z.object({ id: z.number() })

const refused = /\(HTTP 40[34]\)/

function isRefused(error: unknown): boolean {
  return error instanceof ReviewError && refused.test(error.message)
}

async function readable(api: GateApi, path: string): Promise<unknown> {
  try {
    return await api.get(path)
  } catch (error) {
    if (isRefused(error)) return undefined
    throw error
  }
}

type Part = { passed: boolean; detail: string }

async function autoMerge(api: RiskApi, repo: Repo): Promise<Part> {
  const settings = `${repo.html_url}/settings`
  if (autoMergeSchema.parse(await api.get(`repos/${repo.full_name}`)).allow_auto_merge)
    return { passed: true, detail: 'Allow auto-merge is on.' }
  try {
    await api.patch(`repos/${repo.full_name}`, { allow_auto_merge: true })
    return { passed: true, detail: `Turned on Allow auto-merge: ${settings}` }
  } catch (error) {
    if (!isRefused(error)) throw error
    return { passed: false, detail: `Your gh user can't turn on Allow auto-merge; a repo admin can at ${settings}` }
  }
}

type Approval = { approvals: number; dismissesStale: boolean; where: string[] }

async function rulesetApproval(api: GateApi, repo: Repo): Promise<Approval> {
  const branch = encodeURIComponent(repo.default_branch)
  const rules = pullRequestRulesSchema
    .parse(await api.get(`repos/${repo.full_name}/rules/branches/${branch}`))
    .filter((rule) => rule.type === 'pull_request')
  return {
    approvals: Math.max(0, ...rules.map((rule) => rule.parameters?.required_approving_review_count ?? 0)),
    dismissesStale: rules.some((rule) => rule.parameters?.dismiss_stale_reviews_on_push),
    where: rules.flatMap((rule) => (rule.ruleset_id ? [`${repo.html_url}/rules/${rule.ruleset_id}`] : [])),
  }
}

async function classicApproval(api: GateApi, repo: Repo): Promise<Approval> {
  const body = await readable(api, `repos/${repo.full_name}/branches/${encodeURIComponent(repo.default_branch)}/protection`)
  const reviews = body === undefined ? undefined : classicSchema.parse(body).required_pull_request_reviews
  if (!reviews) return { approvals: 0, dismissesStale: false, where: [] }
  return {
    approvals: reviews.required_approving_review_count ?? 0,
    dismissesStale: reviews.dismiss_stale_reviews ?? false,
    where: [`${repo.html_url}/settings/branches`],
  }
}

async function existingRulesetProblem(api: GateApi, repo: Repo): Promise<Part | undefined> {
  const rulesets = rulesetsSchema.parse(await api.get(`repos/${repo.full_name}/rulesets?includes_parents=false&per_page=100`))
  const existing = rulesets.find((ruleset) => ruleset.name === approvalRuleset.name)
  if (!existing) return undefined
  return {
    passed: false,
    detail: `The "${approvalRuleset.name}" ruleset already exists with enforcement \`${existing.enforcement}\` but doesn't require 1 approval and dismiss stale approvals on ${repo.default_branch}: ${repo.html_url}/rules/${existing.id}. Make it do so, or delete it and run this again.`,
  }
}

async function createRuleset(api: GateApi, repo: Repo): Promise<Part> {
  try {
    const { id } = createdSchema.parse(await api.post(`repos/${repo.full_name}/rulesets`, approvalRuleset))
    return {
      passed: true,
      detail: `Added the "${approvalRuleset.name}" ruleset, which requires 1 approval on ${repo.default_branch} and dismisses stale approvals on push: ${repo.html_url}/rules/${id}`,
    }
  } catch (error) {
    if (!isRefused(error)) throw error
    return {
      passed: false,
      detail: `GitHub refused to add the "${approvalRuleset.name}" ruleset requiring 1 approval and dismissing stale approvals: your gh user can't edit ${repo.full_name}'s repository rules. Ask a repo admin to run \`yoke review ci-risk\`.`,
    }
  }
}

async function approvalRule(api: GateApi, repo: Repo): Promise<Part> {
  const sources = [await rulesetApproval(api, repo), await classicApproval(api, repo)]
  const approvals = Math.max(...sources.map((source) => source.approvals))
  if (approvals >= 1 && sources.some((source) => source.dismissesStale)) {
    const where = sources.flatMap((source) => source.where).join(' and ')
    return { passed: true, detail: `${repo.default_branch} requires an approval and dismisses stale approvals on push: ${where}` }
  }
  return (await existingRulesetProblem(api, repo)) ?? createRuleset(api, repo)
}

export async function mergeModeCheck(api: RiskApi, repo: Repo, mode: string | undefined): Promise<Check> {
  if (mode !== 'merge')
    return { name: 'Merge mode', passed: true, detail: `The policy isn't in \`merge\` mode, so no merge settings are needed.` }
  const parts = [await autoMerge(api, repo), await approvalRule(api, repo)]
  return { name: 'Merge mode', passed: parts.every((part) => part.passed), detail: parts.map((part) => part.detail).join(' ') }
}
