import { parse } from 'yaml'
import { z } from 'zod'

import { reviewWorkflowRef } from './ci'

const yokeRepo = 'MakerXStudio/yoke'
const localReviewWorkflow = './.github/workflows/review.yml'
const reviewWorkflowPrefix = reviewWorkflowRef.slice(0, reviewWorkflowRef.indexOf('@') + 1).toLowerCase()

const workflowSchema = z.looseObject({
  on: z.unknown().optional(),
  permissions: z.unknown().optional(),
  jobs: z.record(z.string(), z.looseObject({ uses: z.unknown().optional(), permissions: z.unknown().optional() }).nullable()).optional(),
})

type Workflow = z.infer<typeof workflowSchema>

function parseWorkflow(content: string): Workflow | undefined {
  try {
    const result = workflowSchema.safeParse(parse(content))
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

function callsReview(uses: unknown, repo: string): boolean {
  if (typeof uses !== 'string') return false
  if (uses.toLowerCase().startsWith(reviewWorkflowPrefix)) return true
  return repo.toLowerCase() === yokeRepo.toLowerCase() && uses === localReviewWorkflow
}

function listIncludes(value: unknown, item: string): boolean {
  return value === item || (Array.isArray(value) && value.includes(item))
}

type Event = 'pull_request' | 'pull_request_target'

function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return new Map<string, unknown>(Object.entries(value)).get(key)
}

function eventTrigger(on: unknown, event: Event): Record<string, unknown> | undefined {
  const trigger = property(on, event)
  return typeof trigger === 'object' && trigger !== null && !Array.isArray(trigger) ? { ...trigger } : undefined
}

function runsOn(on: unknown, event: Event, type: string, byDefault: boolean): boolean {
  if (typeof on === 'string' || Array.isArray(on)) return byDefault && listIncludes(on, event)
  if (typeof on !== 'object' || on === null || !(event in on)) return false
  const trigger = eventTrigger(on, event)
  if (!trigger || !('types' in trigger)) return byDefault
  return listIncludes(trigger.types, type)
}

function globMatches(pattern: string, branch: string): boolean {
  const source = pattern
    .split(/(\*\*|\*|\?)/)
    .map((part) => ({ '**': '.*', '*': '[^/]*', '?': '.' })[part] ?? part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('')
  return new RegExp(`^${source}$`).test(branch)
}

function patterns(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function branchesInclude(value: unknown, branch: string): boolean {
  return patterns(value).reduce(
    (included, pattern) =>
      pattern.startsWith('!') ? included && !globMatches(pattern.slice(1), branch) : included || globMatches(pattern, branch),
    false,
  )
}

function skipFilters(on: unknown, event: Event, branch: string): string[] {
  const trigger = eventTrigger(on, event)
  if (!trigger) return []
  const filters = ['paths', 'paths-ignore'].filter((key) => key in trigger)
  if ('branches' in trigger && !branchesInclude(trigger.branches, branch)) filters.push('branches')
  if ('branches-ignore' in trigger && patterns(trigger['branches-ignore']).some((pattern) => globMatches(pattern, branch)))
    filters.push('branches-ignore')
  return filters
}

function canWrite(permissions: unknown, scope: string): boolean {
  if (permissions === 'write-all') return true
  return property(permissions, scope) === 'write'
}

const writeScopes = ['actions', 'statuses']

export type CallerCheck = { path: string; problems: string[] }

function filterProblem(on: unknown, event: Event, branch: string): string[] {
  const filters = skipFilters(on, event, branch)
  if (filters.length === 0) return []
  const named = filters.map((filter) => `\`${filter}\``).join(', ')
  return [
    `skips some PRs to ${branch} through its \`${event}\` ${named} filter${filters.length > 1 ? 's' : ''}, so those PRs could never merge`,
  ]
}

function checkWorkflow(path: string, workflow: Workflow, repo: string, branch: string): CallerCheck | undefined {
  const jobs = Object.values(workflow.jobs ?? {}).filter((job) => job && callsReview(job.uses, repo))
  if (jobs.length === 0) return undefined
  const problems: string[] = []
  if (!runsOn(workflow.on, 'pull_request', 'synchronize', true)) problems.push('lacks the `synchronize` type in its `pull_request` trigger')
  if (!runsOn(workflow.on, 'pull_request_target', 'labeled', false))
    problems.push('lacks a `pull_request_target` trigger with the `labeled` type, so fork PRs can never pass the gate')
  else if (!runsOn(workflow.on, 'pull_request_target', 'synchronize', true))
    problems.push(
      "lacks the `synchronize` type in its `pull_request_target` trigger, so a push to an approved fork PR keeps the `review` label and a maintainer can't re-approve it",
    )
  const missing = writeScopes.filter((scope) => !jobs.some((job) => canWrite(job?.permissions ?? workflow.permissions, scope)))
  if (missing.length > 0) problems.push(`lacks ${missing.map((scope) => `\`${scope}: write\``).join(' and ')} in its permissions`)
  problems.push(...filterProblem(workflow.on, 'pull_request', branch), ...filterProblem(workflow.on, 'pull_request_target', branch))
  return { path, problems }
}

export function checkCallerWorkflows(files: { path: string; content: string }[], repo: string, branch: string): CallerCheck | undefined {
  const callers = files.flatMap(({ path, content }) => {
    const workflow = parseWorkflow(content)
    const check = workflow && checkWorkflow(path, workflow, repo, branch)
    return check ? [check] : []
  })
  return callers.find((caller) => caller.problems.length === 0) ?? callers[0]
}
