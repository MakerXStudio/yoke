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

function runsOnSynchronize(on: unknown): boolean {
  if (typeof on === 'string' || Array.isArray(on)) return listIncludes(on, 'pull_request')
  if (typeof on !== 'object' || on === null || !('pull_request' in on)) return false
  const trigger: unknown = on.pull_request
  if (typeof trigger !== 'object' || trigger === null || !('types' in trigger)) return true
  return listIncludes(trigger.types, 'synchronize')
}

function canReadActions(permissions: unknown): boolean {
  if (permissions === 'read-all' || permissions === 'write-all') return true
  if (typeof permissions !== 'object' || permissions === null || !('actions' in permissions)) return false
  return permissions.actions === 'read' || permissions.actions === 'write'
}

export type CallerCheck = { path: string; missing: string[] }

function checkWorkflow(path: string, workflow: Workflow, repo: string): CallerCheck | undefined {
  const jobs = Object.values(workflow.jobs ?? {}).filter((job) => job && callsReview(job.uses, repo))
  if (jobs.length === 0) return undefined
  const missing: string[] = []
  if (!runsOnSynchronize(workflow.on)) missing.push('the `synchronize` type in its `pull_request` trigger')
  if (!jobs.some((job) => canReadActions(job?.permissions ?? workflow.permissions))) missing.push('`actions: read` in its permissions')
  return { path, missing }
}

export function checkCallerWorkflows(files: { path: string; content: string }[], repo: string): CallerCheck | undefined {
  const callers = files.flatMap(({ path, content }) => {
    const workflow = parseWorkflow(content)
    const check = workflow && checkWorkflow(path, workflow, repo)
    return check ? [check] : []
  })
  return callers.find((caller) => caller.missing.length === 0) ?? callers[0]
}
