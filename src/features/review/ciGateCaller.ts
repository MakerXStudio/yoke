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

function pullRequestTrigger(on: unknown): Record<string, unknown> | undefined {
  if (typeof on !== 'object' || on === null || Array.isArray(on) || !('pull_request' in on)) return undefined
  const trigger: unknown = on.pull_request
  return typeof trigger === 'object' && trigger !== null && !Array.isArray(trigger) ? { ...trigger } : undefined
}

function runsOnSynchronize(on: unknown): boolean {
  if (typeof on === 'string' || Array.isArray(on)) return listIncludes(on, 'pull_request')
  if (typeof on !== 'object' || on === null || !('pull_request' in on)) return false
  const trigger = pullRequestTrigger(on)
  if (!trigger || !('types' in trigger)) return true
  return listIncludes(trigger.types, 'synchronize')
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

function skipFilters(on: unknown, branch: string): string[] {
  const trigger = pullRequestTrigger(on)
  if (!trigger) return []
  const filters = ['paths', 'paths-ignore'].filter((key) => key in trigger)
  if ('branches' in trigger && !branchesInclude(trigger.branches, branch)) filters.push('branches')
  if ('branches-ignore' in trigger && patterns(trigger['branches-ignore']).some((pattern) => globMatches(pattern, branch)))
    filters.push('branches-ignore')
  return filters
}

function canReadActions(permissions: unknown): boolean {
  if (permissions === 'read-all' || permissions === 'write-all') return true
  if (typeof permissions !== 'object' || permissions === null || !('actions' in permissions)) return false
  return permissions.actions === 'read' || permissions.actions === 'write'
}

export type CallerCheck = { path: string; problems: string[] }

function checkWorkflow(path: string, workflow: Workflow, repo: string, branch: string): CallerCheck | undefined {
  const jobs = Object.values(workflow.jobs ?? {}).filter((job) => job && callsReview(job.uses, repo))
  if (jobs.length === 0) return undefined
  const problems: string[] = []
  if (!runsOnSynchronize(workflow.on)) problems.push('lacks the `synchronize` type in its `pull_request` trigger')
  if (!jobs.some((job) => canReadActions(job?.permissions ?? workflow.permissions)))
    problems.push('lacks `actions: read` in its permissions')
  const filters = skipFilters(workflow.on, branch)
  if (filters.length > 0)
    problems.push(
      `skips some PRs to ${branch} through its \`pull_request\` ${filters.map((filter) => `\`${filter}\``).join(', ')} filter${filters.length > 1 ? 's' : ''}, so those PRs could never merge`,
    )
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
