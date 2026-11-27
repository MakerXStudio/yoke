import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import { repoRoot } from './ci'
import { enforceReviewGate, type GateApi, type Repo, repoSchema } from './ciGate'
import { appKeySecret } from './ciRisk'
import { appNames, findCaller, workflowCheck } from './ciRiskCaller'
import { defaultClientIdVariable } from './ciRiskLocal'
import { lockFileProblem } from './ciRiskLockFiles'
import { mergeModeCheck, type RiskApi } from './ciRiskMerge'
import { orgCheck, secretKind, variableKind } from './ciRiskOrg'
import { appCheck, workingCheck } from './ciRiskRuns'
import { githubGet, githubLog, githubPatch, githubPost, ReviewError } from './pr'
import { fetchPolicy } from './riskInputs'
import { parseRiskPolicy, RiskPolicyError, riskPolicyPath } from './riskPolicy'

export type Check = { name: string; passed: boolean; detail: string }

const ownedRepoSchema = repoSchema.extend({ owner: z.object({ login: z.string(), type: z.string() }), private: z.boolean() })

export type OwnedRepo = z.infer<typeof ownedRepoSchema>

const githubApi: RiskApi = {
  get: (path) => githubGet(path),
  post: (path, body) => githubPost(path, body),
  patch: (path, body) => githubPatch(path, body),
  log: (path) => githubLog(path),
}

async function gateCheck(api: GateApi): Promise<Check> {
  try {
    return { name: 'Gate', passed: true, detail: (await enforceReviewGate(api)).message }
  } catch (error) {
    if (!(error instanceof ReviewError)) throw error
    return { name: 'Gate', passed: false, detail: error.message }
  }
}

type PolicyResult = { check: Check; mode: string | undefined }

type LocalPolicy = { mode?: string; error?: string }

function localPolicy(root: string): LocalPolicy {
  const path = join(root, riskPolicyPath)
  if (!existsSync(path)) return {}
  try {
    const policy = parseRiskPolicy(readFileSync(path, 'utf8'))
    const lockFiles = lockFileProblem(policy.alwaysHuman)
    return { mode: policy.mode, ...(lockFiles ? { error: `${riskPolicyPath} ${lockFiles}` } : {}) }
  } catch (error) {
    if (error instanceof RiskPolicyError) return { error: error.message }
    throw error
  }
}

async function policyCheck(api: GateApi, repo: Repo, root: string): Promise<PolicyResult> {
  const policy = await fetchPolicy(repo.full_name, api)
  const branch = repo.default_branch
  const { mode, error: localError } = localPolicy(root)
  if (localError) return { check: { name: 'Policy', passed: false, detail: `The local ${localError}` }, mode }
  if (!policy) {
    const detail = `No ${riskPolicyPath} on ${branch}: ${repo.html_url}/tree/${branch}/.github. Add one and merge it to ${branch}.`
    return { check: { name: 'Policy', passed: false, detail }, mode }
  }
  try {
    const merged = parseRiskPolicy(policy.text).mode
    return { check: { name: 'Policy', passed: true, detail: `${policy.url} parses, in \`${merged}\` mode.` }, mode: mode ?? merged }
  } catch (error) {
    if (!(error instanceof RiskPolicyError)) throw error
    return { check: { name: 'Policy', passed: false, detail: `${policy.url}: ${error.message}` }, mode }
  }
}

export async function checkRiskSetup(api: RiskApi = githubApi, root = repoRoot()): Promise<{ repo: string; checks: Check[] }> {
  const repo = ownedRepoSchema.parse(await api.get('repos/{owner}/{repo}'))
  const gate = await gateCheck(api)
  const caller = await findCaller(api, repo)
  const names = caller ? appNames(caller) : { variable: defaultClientIdVariable, secret: appKeySecret }
  const policy = await policyCheck(api, repo, root)
  const checks = [
    gate,
    workflowCheck(repo, caller, root),
    await orgCheck(api, repo, variableKind, names.variable),
    await orgCheck(api, repo, secretKind, names.secret),
    policy.check,
    await mergeModeCheck(api, repo, policy.mode),
    await appCheck(api, repo, caller),
    await workingCheck(api, repo),
  ]
  return { repo: repo.full_name, checks }
}

export function renderChecklist({ repo, checks }: { repo: string; checks: Check[] }): string {
  const failed = checks.filter((check) => !check.passed).length
  return [
    `Risk-based review setup for ${repo}:`,
    ...checks.map(({ name, passed, detail }) => `${passed ? '✓' : '✗'} ${name}: ${detail.replaceAll('\n', '\n    ')}`),
    '',
    failed ? `${failed} of ${checks.length} requirements not met yet.` : 'Every requirement passes; risk-based review is set up.',
  ].join('\n')
}
