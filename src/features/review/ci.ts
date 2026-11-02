import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { howToSet, type SettingKey, type Settings } from '../config/settings'
import { type EntraAuth, entraSetup } from './ciEntra'
import { ReviewError } from './pr'
import { isHarness, isProviderKind, type ProviderKind, providerKinds } from './provider'
import { shellQuote } from './shellQuote'

export const reviewWorkflowRef = 'MakerXStudio/yoke/.github/workflows/review.yml@main'

export const callerWorkflowPath = join('.github', 'workflows', 'review-pr.yml')

export const baseUrlVariable = 'REVIEW_CI_BASE_URL'
export const apiKeySecret = 'REVIEW_CI_API_KEY'

export const callerTriggerTypes = ['opened', 'synchronize', 'reopened', 'ready_for_review']

export const gateCheck = 'review / gate'

type Input = [name: string, value: string]

export type EntraFlags = { azureClientId?: string; azureTenantId?: string; environment?: string }

export type CallerWorkflow = { provider: ProviderKind; inputs: Input[]; entra?: EntraAuth }

export function workflowSecrets({ entra }: CallerWorkflow): string[] {
  return entra ? [] : [apiKeySecret]
}

function entraInputs({ azureClientId, azureTenantId, environment }: EntraFlags, provider: string, errors: string[]): Input[] {
  const clientId = azureClientId?.trim()
  const tenantId = azureTenantId?.trim()
  const env = environment?.trim()
  if (!clientId && !tenantId) {
    if (env) errors.push('--environment needs --azure-client-id and --azure-tenant-id')
    return []
  }
  if (!clientId) errors.push('--azure-client-id is required with --azure-tenant-id')
  if (!tenantId) errors.push('--azure-tenant-id is required with --azure-client-id')
  if (provider !== 'foundry') errors.push('--azure-client-id and --azure-tenant-id need --provider foundry')
  return [['azure-client-id', clientId ?? ''], ['azure-tenant-id', tenantId ?? ''], ...(env ? [['environment', env] satisfies Input] : [])]
}

const slots = [
  { slot: 'reviewer1', defaultHarness: 'claude', required: true },
  { slot: 'reviewer2', defaultHarness: 'codex', required: true },
  { slot: 'synthesis', defaultHarness: undefined, required: false },
] as const

function slotInputs(settings: Settings, errors: string[]): Input[] {
  const inputs: Input[] = []
  for (const { slot, defaultHarness, required } of slots) {
    const harnessKey = `review.${slot}.harness` as const satisfies SettingKey
    const modelKey = `review.${slot}.model` as const satisfies SettingKey
    const harness = settings[harnessKey] ?? defaultHarness
    const model = settings[modelKey]
    if (harness && !isHarness(harness))
      errors.push(`${harnessKey} "${harness}" must be claude or codex; ${howToSet(harnessKey, '<claude|codex>')}`)
    if (required && !model) errors.push(`${modelKey} is required; ${howToSet(modelKey, '<model>')} (see \`yoke models\`)`)
    if (!required && harness && !model)
      errors.push(`${modelKey} is required when ${harnessKey} is set; ${howToSet(modelKey, '<model>')} (see \`yoke models\`)`)
    if (harness) inputs.push([`${slot}-harness`, harness])
    if (model) inputs.push([`${slot}-model`, model])
  }
  return inputs
}

export function callerWorkflow(settings: Settings, providerFlag?: string, entraFlags: EntraFlags = {}): CallerWorkflow {
  const errors: string[] = []
  const provider = providerFlag ?? settings['review.reviewer1.provider'] ?? 'litellm'
  if (!isProviderKind(provider)) errors.push(`provider "${provider}" must be ${providerKinds.join(' or ')}; pass --provider`)
  const inputs = slotInputs(settings, errors)
  const entra = entraInputs(entraFlags, provider, errors)
  if (errors.length || !isProviderKind(provider))
    throw new ReviewError(['Cannot write the review workflow:', ...errors.map((error) => `- ${error}`)].join('\n'))
  const environment = entraFlags.environment?.trim()
  return {
    provider,
    inputs: [['provider', provider], ...inputs, ...entra],
    ...(entra.length > 0 && { entra: { clientId: entraFlags.azureClientId?.trim() ?? '', ...(environment && { environment }) } }),
  }
}

function yamlValue(value: string): string {
  return /^[\w./:@-]+$/.test(value) && !/^([-+.\d_eE]+|0[xo][\da-f]+|true|false|yes|no|on|off|y|n|null|~)$/i.test(value)
    ? value
    : JSON.stringify(value)
}

export function renderCallerWorkflow(workflow: CallerWorkflow): string {
  const secrets = workflowSecrets(workflow)
  return [
    'name: Review PR',
    '',
    'on:',
    '  pull_request:',
    `    types: [${callerTriggerTypes.join(', ')}]`,
    '',
    'permissions:',
    '  actions: read',
    '  contents: read',
    '  pull-requests: write',
    ...(workflow.entra ? ['  id-token: write'] : []),
    '',
    'jobs:',
    '  review:',
    `    uses: ${reviewWorkflowRef}`,
    '    with:',
    ...workflow.inputs.map(([name, value]) => `      ${name}: ${yamlValue(value)}`),
    `      base-url: \${{ vars.${baseUrlVariable} }}`,
    ...(secrets.length > 0 ? ['    secrets:', ...secrets.map((secret) => `      ${secret}: \${{ secrets.${secret} }}`)] : []),
    '',
  ].join('\n')
}

export function setupCommands(settings: Settings, workflow: CallerWorkflow): string[] {
  const baseUrl = settings[`${workflow.provider}.baseUrl`]
  return [
    `gh variable set ${baseUrlVariable}${baseUrl ? ` --body ${shellQuote(baseUrl)}` : ''}`,
    ...workflowSecrets(workflow).map((secret) => `gh secret set ${secret}`),
  ]
}

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

export function rulesetCommand(): string {
  return `echo ${shellQuote(JSON.stringify(gateRuleset))} | gh api --method POST 'repos/{owner}/{repo}/rulesets' --input -`
}

const unknownRepo = '<owner>/<repo>'

export function githubRepo(cwd = process.cwd()): string {
  try {
    return (
      execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || unknownRepo
    )
  } catch {
    return unknownRepo
  }
}

export function repoRoot(cwd = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    throw new ReviewError('Not in a git repository; run `yoke review-ci` from the repo to review.')
  }
}

export type WriteOutcome = 'wrote' | 'unchanged'

export function writeCallerWorkflow(root: string, content: string, force: boolean): WriteOutcome {
  const path = join(root, callerWorkflowPath)
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === content) return 'unchanged'
    if (!force) throw new ReviewError(`${callerWorkflowPath} already exists and differs; pass --force to overwrite it.`)
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return 'wrote'
}

export function reviewCiReport(outcome: WriteOutcome, settings: Settings, workflow: CallerWorkflow, repo: () => string): string {
  const action = outcome === 'wrote' ? 'wrote' : 'kept'
  const reads = [`variable ${baseUrlVariable}`, ...workflowSecrets(workflow).map((secret) => `secret ${secret}`)]
  return [
    `${action} ${callerWorkflowPath}`,
    '',
    `The workflow reads ${reads.join(' and ')}. Set ${reads.length > 1 ? 'them' : 'it'} on the repo (or the org) with:`,
    ...setupCommands(settings, workflow).map((command) => `  ${command}`),
    ...(workflow.entra ? entraSetup(workflow.entra, repo()) : []),
    '',
    'Commit and push the workflow; each PR opened from this repo then gets a review.',
    '',
    `To block merging while the review fails, require the ${gateCheck} check on the default branch with:`,
    `  ${rulesetCommand()}`,
    'Run it only after this workflow is merged to the default branch, or pushes to open PRs get stuck waiting for a status.',
  ].join('\n')
}
