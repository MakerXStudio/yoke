import { callerWorkflowPath } from './ci'
import type { GateApi, Repo } from './ciGate'
import { workflowFiles } from './ciGate'
import { callsReview, parseWorkflow } from './ciGateCaller'
import { appKeySecret } from './ciRisk'
import type { Check } from './ciRiskCheck'
import { addLocalAppInputs, appClientIdInput, type LocalEdit } from './ciRiskLocal'

export type Caller = { path: string; clientId: unknown; secrets: unknown }

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {}
}

export async function findCaller(api: GateApi, repo: Repo): Promise<Caller | undefined> {
  for (const { path, content } of await workflowFiles(api, repo)) {
    const job = Object.values(parseWorkflow(content)?.jobs ?? {}).find((entry) => entry && callsReview(entry.uses, repo.full_name))
    if (job) return { path, clientId: record(job.with)[appClientIdInput], secrets: job.secrets }
  }
  return undefined
}

function passesKey(secrets: unknown): boolean {
  return secrets === 'inherit' || appKeySecret in record(secrets)
}

type AppNames = { variable: string | undefined; secret: string }

export function appNames(caller: Caller): AppNames {
  const variable = typeof caller.clientId === 'string' ? /\$\{\{\s*vars\.(\w+)\s*\}\}/.exec(caller.clientId)?.[1] : undefined
  const passed = record(caller.secrets)[appKeySecret]
  const secret = typeof passed === 'string' ? (/\$\{\{\s*secrets\.(\w+)\s*\}\}/.exec(passed)?.[1] ?? appKeySecret) : appKeySecret
  return { variable, secret }
}

function localNote(edit: LocalEdit | undefined, branch: string): string | undefined {
  if (!edit) return undefined
  if (!edit.added.length) return `The local ${edit.path} already passes them; commit it and merge it to ${branch}.`
  return `Added ${edit.added.join(' and ')} to the local ${edit.path}; commit it and merge it to ${branch}.`
}

function missingInputs(caller: Caller): string[] {
  return [
    ...(typeof caller.clientId === 'string' && caller.clientId.trim() ? [] : [`\`${appClientIdInput}\` input`]),
    ...(passesKey(caller.secrets) ? [] : [`\`${appKeySecret}\` secret`]),
  ]
}

export function workflowCheck(repo: Repo, caller: Caller | undefined, root: string): Check {
  const branch = repo.default_branch
  const missing = caller ? missingInputs(caller) : []
  if (caller && !missing.length)
    return {
      name: 'Workflow',
      passed: true,
      detail: `${repo.html_url}/blob/${branch}/${caller.path} passes the yoke-review App's client ID and private key.`,
    }
  const note = localNote(addLocalAppInputs(root, caller?.path ?? callerWorkflowPath, repo.full_name), branch)
  const problem = caller
    ? `${repo.html_url}/blob/${branch}/${caller.path} on ${branch} doesn't pass the ${missing.join(' or the ')} to yoke's review.yml.`
    : `No workflow on ${branch} calls yoke's review.yml.`
  const fix = caller ? `Run this again in a checkout with ${caller.path}.` : `Run /review-ci, then run this again.`
  return { name: 'Workflow', passed: false, detail: `${problem} ${note ?? fix}` }
}
