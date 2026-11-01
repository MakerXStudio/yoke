import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { howToSet, type SettingKey, type Settings } from '../config/settings'
import { ReviewError } from './pr'
import { isHarness, isProviderKind, type ProviderKind, providerKinds } from './provider'

export const reviewWorkflowRef = 'MakerXStudio/yoke/.github/workflows/review.yml@main'

export const callerWorkflowPath = join('.github', 'workflows', 'review-pr.yml')

const ciSecrets = ['REVIEW_CI_BASE_URL', 'REVIEW_CI_API_KEY'] as const

type Input = [name: string, value: string]

export type CallerWorkflow = { provider: ProviderKind; inputs: Input[] }

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
    if (harness) inputs.push([`${slot}-harness`, harness])
    if (model) inputs.push([`${slot}-model`, model])
  }
  return inputs
}

export function callerWorkflow(settings: Settings, providerFlag?: string): CallerWorkflow {
  const errors: string[] = []
  const provider = providerFlag ?? settings['review.reviewer1.provider'] ?? 'litellm'
  if (!isProviderKind(provider)) errors.push(`provider "${provider}" must be ${providerKinds.join(' or ')}; pass --provider`)
  const inputs = slotInputs(settings, errors)
  if (errors.length || !isProviderKind(provider))
    throw new ReviewError(['Cannot write the review workflow:', ...errors.map((error) => `- ${error}`)].join('\n'))
  return { provider, inputs: [['provider', provider], ...inputs] }
}

function yamlValue(value: string): string {
  return /^[\w./:@-]+$/.test(value) ? value : JSON.stringify(value)
}

export function renderCallerWorkflow({ inputs }: CallerWorkflow): string {
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
    '',
    'jobs:',
    '  review:',
    `    uses: ${reviewWorkflowRef}`,
    '    with:',
    ...inputs.map(([name, value]) => `      ${name}: ${yamlValue(value)}`),
    '    secrets: inherit',
    '',
  ].join('\n')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function secretCommands(settings: Settings, provider: ProviderKind): string[] {
  const baseUrl = settings[`${provider}.baseUrl`]
  return [`gh secret set REVIEW_CI_BASE_URL${baseUrl ? ` --body ${shellQuote(baseUrl)}` : ''}`, 'gh secret set REVIEW_CI_API_KEY']
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

export function reviewCiReport(outcome: WriteOutcome, commands: string[]): string {
  const action = outcome === 'wrote' ? 'wrote' : 'kept'
  return [
    `${action} ${callerWorkflowPath}`,
    '',
    `The workflow reads ${ciSecrets.join(' and ')}. Set them on the repo (or the org) with:`,
    ...commands.map((command) => `  ${command}`),
    '',
    'Commit and push the workflow; each PR opened from this repo then gets a review.',
  ].join('\n')
}
