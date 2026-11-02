import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { howToSet, type SettingKey, type Settings } from '../config/settings'
import { ReviewError } from './pr'
import { isHarness, isProviderKind, type ProviderKind, providerKinds } from './provider'

export const reviewWorkflowRef = 'MakerXStudio/yoke/.github/workflows/review.yml@main'

export const callerWorkflowPath = join('.github', 'workflows', 'review-pr.yml')

export const baseUrlSecret = 'REVIEW_CI_BASE_URL'
export const apiKeySecret = 'REVIEW_CI_API_KEY'

type Input = [name: string, value: string]

export type EntraFlags = { azureClientId?: string; azureTenantId?: string; environment?: string }

type EntraAuth = { clientId: string; environment?: string }

export type CallerWorkflow = { provider: ProviderKind; inputs: Input[]; entra?: EntraAuth }

export function workflowSecrets({ entra }: CallerWorkflow): string[] {
  return entra ? [baseUrlSecret] : [baseUrlSecret, apiKeySecret]
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
  return [
    'name: Review PR',
    '',
    'on:',
    '  pull_request:',
    '    types: [opened, reopened, ready_for_review]',
    '',
    'permissions:',
    '  contents: read',
    '  pull-requests: write',
    ...(workflow.entra ? ['  id-token: write'] : []),
    '',
    'jobs:',
    '  review:',
    `    uses: ${reviewWorkflowRef}`,
    '    with:',
    ...workflow.inputs.map(([name, value]) => `      ${name}: ${yamlValue(value)}`),
    '    secrets:',
    ...workflowSecrets(workflow).map((secret) => `      ${secret}: \${{ secrets.${secret} }}`),
    '',
  ].join('\n')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function secretCommands(settings: Settings, workflow: CallerWorkflow): string[] {
  const baseUrl = settings[`${workflow.provider}.baseUrl`]
  return workflowSecrets(workflow).map((secret) =>
    secret === baseUrlSecret && baseUrl ? `gh secret set ${secret} --body ${shellQuote(baseUrl)}` : `gh secret set ${secret}`,
  )
}

const githubOidcIssuer = 'https://token.actions.githubusercontent.com'

const entraTokenExchangeAudience = 'api://AzureADTokenExchange'

export type FederatedCredential = { issuer: string; audience: string; subject: string }

export function federatedCredential(repo: string, environment?: string): FederatedCredential {
  return {
    issuer: githubOidcIssuer,
    audience: entraTokenExchangeAudience,
    subject: environment ? `repo:${repo}:environment:${environment}` : `repo:${repo}:pull_request`,
  }
}

function federatedCredentialCommand(clientId: string, credential: FederatedCredential): string {
  const parameters = JSON.stringify({
    name: 'yoke-review-ci',
    issuer: credential.issuer,
    subject: credential.subject,
    audiences: [credential.audience],
  })
  return `az ad app federated-credential create --id ${shellQuote(clientId)} --parameters ${shellQuote(parameters)}`
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

function entraSetup({ clientId, environment }: EntraAuth, repo: string): string[] {
  const credential = federatedCredential(repo, environment)
  return [
    '',
    `Instead of REVIEW_CI_API_KEY, the job signs in to Foundry as Entra app ${clientId} with its GitHub OIDC token. On that app, create a federated credential with:`,
    `  issuer:   ${credential.issuer}`,
    `  audience: ${credential.audience}`,
    `  subject:  ${credential.subject}`,
    'for example with:',
    `  ${federatedCredentialCommand(clientId, credential)}`,
    'and give the app the Cognitive Services User role on the Foundry resource.',
    ...(environment ? [`The job runs in the ${environment} environment; create it on the repo if it does not exist.`] : []),
  ]
}

export function reviewCiReport(outcome: WriteOutcome, settings: Settings, workflow: CallerWorkflow, repo: () => string): string {
  const action = outcome === 'wrote' ? 'wrote' : 'kept'
  const secrets = workflowSecrets(workflow)
  return [
    `${action} ${callerWorkflowPath}`,
    '',
    `The workflow reads ${secrets.join(' and ')}. Set ${secrets.length > 1 ? 'them' : 'it'} on the repo (or the org) with:`,
    ...secretCommands(settings, workflow).map((command) => `  ${command}`),
    ...(workflow.entra ? entraSetup(workflow.entra, repo()) : []),
    '',
    'Commit and push the workflow; each PR opened from this repo then gets a review.',
  ].join('\n')
}
