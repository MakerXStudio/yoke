import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'

import type { Settings } from '../config/settings'
import {
  callerWorkflow,
  callerTriggerTypes,
  callerWorkflowPath,
  type EntraFlags,
  gateCheck,
  renderCallerWorkflow,
  repoRoot,
  reviewCiReport,
  reviewWorkflowRef,
  rulesetCommand,
  setupCommands,
  workflowSecrets,
  writeCallerWorkflow,
} from './ci'
import { federatedCredential } from './ciEntra'

const workflowSchema = z.object({
  on: z.record(
    z.string(),
    z.object({
      types: z.array(z.string()).optional(),
      inputs: z.record(z.string(), z.object({ required: z.boolean().optional() })).optional(),
      secrets: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  permissions: z.record(z.string(), z.string()).optional(),
  jobs: z.record(
    z.string(),
    z.object({
      if: z.string().optional(),
      needs: z.string().optional(),
      uses: z.string().optional(),
      with: z.record(z.string(), z.string()).optional(),
      secrets: z.record(z.string(), z.string()).optional(),
    }),
  ),
})

type Workflow = z.infer<typeof workflowSchema>

const reusableSource = readFileSync(join(import.meta.dirname, '../../../.github/workflows/review.yml'), 'utf8')

const reusable = workflowSchema.parse(parse(reusableSource))

const ownCaller = workflowSchema.parse(parse(readFileSync(join(import.meta.dirname, '../../../.github/workflows/review-pr.yml'), 'utf8')))

const models: Settings = { 'review.reviewer1.model': 'bedrock/claude-opus-5-5', 'review.reviewer2.model': 'azure/gpt-6.1-sol' }

function generated(settings: Settings = models, provider?: string): Workflow {
  return workflowSchema.parse(parse(renderCallerWorkflow(callerWorkflow(settings, provider))))
}

function inputsOf(settings: Settings = models, provider?: string): Record<string, string> {
  return generated(settings, provider).jobs.review?.with ?? {}
}

describe('callerWorkflow', () => {
  it('calls the reusable review workflow on new, ready and pushed-to PRs', () => {
    const workflow = generated()
    expect(workflow.on.pull_request?.types).toEqual(['opened', 'synchronize', 'reopened', 'ready_for_review'])
    expect(workflow.jobs.review?.uses).toBe(reviewWorkflowRef)
  })

  it('lets the gate read earlier runs', () => {
    expect(renderCallerWorkflow(callerWorkflow(models))).toContain('permissions:\n  actions: read\n')
  })

  it('passes only the API key secret, never every repository secret', () => {
    expect(generated().jobs.review?.secrets).toEqual({ REVIEW_CI_API_KEY: '${{ secrets.REVIEW_CI_API_KEY }}' })
  })

  it('reads the base URL from a variable', () => {
    expect(inputsOf()['base-url']).toBe('${{ vars.REVIEW_CI_BASE_URL }}')
  })

  it('passes only inputs the reusable workflow declares, including every required one', () => {
    const declared = reusable.on.workflow_call?.inputs ?? {}
    const passed = inputsOf({ ...models, 'review.synthesis.harness': 'codex', 'review.synthesis.model': 'azure/gpt-6.1-sol' })
    expect(Object.keys(declared)).toEqual(expect.arrayContaining(Object.keys(passed)))
    const required = Object.entries(declared).flatMap(([name, input]) => (input.required ? [name] : []))
    expect(Object.keys(passed)).toEqual(expect.arrayContaining(required))
  })

  it('passes only secrets the reusable workflow declares', () => {
    expect(Object.keys(reusable.on.workflow_call?.secrets ?? {})).toEqual(
      expect.arrayContaining(Object.keys(generated().jobs.review?.secrets ?? {})),
    )
  })

  it('still accepts the base URL as a secret from older callers', () => {
    expect(reusable.on.workflow_call?.secrets).toHaveProperty('REVIEW_CI_BASE_URL')
    expect(reusableSource).toContain("inputs.provider == 'litellm' && (inputs.base-url || secrets.REVIEW_CI_BASE_URL)")
    expect(reusableSource).toContain("inputs.provider == 'foundry' && (inputs.base-url || secrets.REVIEW_CI_BASE_URL)")
  })

  it('defaults to litellm with claude and codex reviewers', () => {
    expect(inputsOf()).toEqual({
      'base-url': '${{ vars.REVIEW_CI_BASE_URL }}',
      provider: 'litellm',
      'reviewer1-harness': 'claude',
      'reviewer1-model': 'bedrock/claude-opus-5-5',
      'reviewer2-harness': 'codex',
      'reviewer2-model': 'azure/gpt-6.1-sol',
    })
  })

  it('takes the provider from the flag over reviewer 1 provider setting', () => {
    expect(inputsOf({ ...models, 'review.reviewer1.provider': 'foundry' }).provider).toBe('foundry')
    expect(inputsOf({ ...models, 'review.reviewer1.provider': 'foundry' }, 'litellm').provider).toBe('litellm')
  })

  it('passes synthesis inputs only when they are set', () => {
    expect(inputsOf()).not.toHaveProperty('synthesis-model')
    expect(inputsOf({ ...models, 'review.synthesis.model': 'claude-sonnet-5-5' })).toMatchObject({ 'synthesis-model': 'claude-sonnet-5-5' })
  })

  it('quotes a model that is not a plain YAML scalar', () => {
    expect(inputsOf({ ...models, 'review.reviewer1.model': 'model: #1' })['reviewer1-model']).toBe('model: #1')
  })

  it.each(['1.0', '123', 'true', 'No', 'null', '~', '1e3', '0x1f'])('keeps model %s a string', (model) => {
    expect(inputsOf({ ...models, 'review.reviewer1.model': model })['reviewer1-model']).toBe(model)
  })

  it('requires a synthesis model when the synthesis harness is set', () => {
    expect(() => callerWorkflow({ ...models, 'review.synthesis.harness': 'codex' })).toThrow(
      /review\.synthesis\.model is required when review\.synthesis\.harness is set/,
    )
  })

  it('names every missing or invalid setting', () => {
    expect(() => callerWorkflow({ 'review.reviewer1.harness': 'gemini' }, 'bedrock')).toThrow(
      /provider "bedrock" must be litellm or foundry[\s\S]*review\.reviewer1\.harness "gemini"[\s\S]*review\.reviewer1\.model is required[\s\S]*review\.reviewer2\.model is required/,
    )
  })
})

describe('reusable workflow', () => {
  const stepsSchema = z.object({ jobs: z.record(z.string(), z.object({ steps: z.array(z.object({ run: z.string().optional() })) })) })

  it('keeps logic in yoke, not in run scripts', () => {
    const runs = Object.values(stepsSchema.parse(parse(reusableSource)).jobs).flatMap((job) => job.steps.flatMap((step) => step.run ?? []))
    for (const run of runs) expect(run.trim().split('\n').length, run).toBeLessThanOrEqual(2)
  })
})

describe('gate', () => {
  it('runs after the review whatever its result', () => {
    expect(reusable.jobs.gate).toMatchObject({ needs: 'review', if: 'always()' })
  })

  it('skips the review on pushes', () => {
    expect(reusable.jobs.review?.if).toMatch(/^github\.event\.action != 'synchronize' && /)
  })

  it("triggers yoke's own review on pushes and lets the gate read earlier runs", () => {
    expect(ownCaller.on.pull_request?.types).toEqual(callerTriggerTypes)
    expect(ownCaller.permissions).toMatchObject({ actions: 'read' })
  })

  it('names the check the ruleset requires after the caller and gate jobs', () => {
    expect(Object.keys(generated().jobs)).toEqual(['review'])
    expect(gateCheck).toBe('review / gate')
  })
})

describe('Entra auth', () => {
  const entra = { azureClientId: 'client-1', azureTenantId: 'tenant-1' }

  function entraWorkflow(flags: EntraFlags = entra): Workflow {
    return workflowSchema.parse(parse(renderCallerWorkflow(callerWorkflow(models, 'foundry', flags))))
  }

  it('passes the client and tenant IDs and grants id-token write', () => {
    const rendered = renderCallerWorkflow(callerWorkflow(models, 'foundry', entra))
    expect(rendered).toContain('permissions:\n  actions: read\n  contents: read\n  pull-requests: write\n  id-token: write\n')
    expect(entraWorkflow().jobs.review?.with).toMatchObject({ 'azure-client-id': 'client-1', 'azure-tenant-id': 'tenant-1' })
    expect(entraWorkflow().jobs.review?.with).not.toHaveProperty('environment')
  })

  it('passes the environment when given', () => {
    expect(entraWorkflow({ ...entra, environment: 'review' }).jobs.review?.with).toMatchObject({ environment: 'review' })
  })

  it('passes no secrets', () => {
    expect(renderCallerWorkflow(callerWorkflow(models, 'foundry', entra))).not.toContain('secrets:')
  })

  it('passes only inputs the reusable workflow declares', () => {
    const declared = Object.keys(reusable.on.workflow_call?.inputs ?? {})
    expect(declared).toEqual(
      expect.arrayContaining(Object.keys(entraWorkflow({ ...entra, environment: 'review' }).jobs.review?.with ?? {})),
    )
  })

  it('leaves id-token write and the Entra inputs out for an API key', () => {
    expect(renderCallerWorkflow(callerWorkflow(models, 'foundry'))).not.toContain('id-token')
    expect(inputsOf(models, 'foundry')).not.toHaveProperty('azure-client-id')
  })

  it('needs both IDs, foundry, and Entra for an environment', () => {
    expect(() => callerWorkflow(models, 'foundry', { azureClientId: 'client-1' })).toThrow(/--azure-tenant-id is required/)
    expect(() => callerWorkflow(models, 'foundry', { azureTenantId: 'tenant-1' })).toThrow(/--azure-client-id is required/)
    expect(() => callerWorkflow(models, 'litellm', entra)).toThrow(/need --provider foundry/)
    expect(() => callerWorkflow(models, 'foundry', { environment: 'review' })).toThrow(/--environment needs --azure-client-id/)
  })
})

describe('setupCommands', () => {
  const litellm = callerWorkflow(models, 'litellm')

  it('sets the base URL the provider is configured with as a variable', () => {
    expect(setupCommands({ 'litellm.baseUrl': 'https://litellm.example.com' }, litellm)).toEqual([
      "gh variable set REVIEW_CI_BASE_URL --body 'https://litellm.example.com'",
      'gh secret set REVIEW_CI_API_KEY',
    ])
  })

  it('prompts for the base URL when it is not configured', () => {
    expect(setupCommands({ 'litellm.baseUrl': 'https://litellm.example.com' }, callerWorkflow(models, 'foundry'))[0]).toBe(
      'gh variable set REVIEW_CI_BASE_URL',
    )
  })

  it('never puts the API key on the command line', () => {
    expect(setupCommands({ 'litellm.apiKey': 'sk-secret' }, litellm).join('\n')).not.toContain('sk-secret')
  })

  it('asks for no API key with Entra auth', () => {
    const workflow = callerWorkflow(models, 'foundry', { azureClientId: 'client-1', azureTenantId: 'tenant-1' })
    expect(setupCommands({}, workflow)).toEqual(['gh variable set REVIEW_CI_BASE_URL'])
    expect(workflowSecrets(workflow)).toEqual([])
  })
})

describe('writeCallerWorkflow', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'yoke-review-ci-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes the workflow, then leaves an identical copy alone', () => {
    expect(writeCallerWorkflow(root, 'content', false)).toBe('wrote')
    expect(readFileSync(join(root, callerWorkflowPath), 'utf8')).toBe('content')
    expect(writeCallerWorkflow(root, 'content', false)).toBe('unchanged')
  })

  it('refuses to overwrite a different workflow without --force', () => {
    writeCallerWorkflow(root, 'mine', false)
    expect(() => writeCallerWorkflow(root, 'yoke', false)).toThrow(/--force/)
    expect(writeCallerWorkflow(root, 'yoke', true)).toBe('wrote')
    expect(readFileSync(join(root, callerWorkflowPath), 'utf8')).toBe('yoke')
  })

  it('finds the repo root from a subdirectory', () => {
    execFileSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(join(root, 'sub'))
    expect(repoRoot(join(root, 'sub'))).toBe(realpathSync(root))
  })

  it('fails outside a git repository', () => {
    expect(() => repoRoot(tmpdir())).toThrow(/Not in a git repository/)
  })
})

describe('federatedCredential', () => {
  it('trusts pull_request tokens from the repo without an environment', () => {
    expect(federatedCredential('o/r')).toEqual({
      issuer: 'https://token.actions.githubusercontent.com',
      audience: 'api://AzureADTokenExchange',
      subject: 'repo:o/r:pull_request',
    })
  })

  it('trusts the environment when the job runs in one', () => {
    expect(federatedCredential('o/r', 'review').subject).toBe('repo:o/r:environment:review')
  })
})

function noRepo(): string {
  throw new Error('repo looked up without Entra auth')
}

describe('reviewCiReport', () => {
  it('lists the workflow and each secret command', () => {
    const report = reviewCiReport('wrote', { 'litellm.baseUrl': 'https://litellm.example.com' }, callerWorkflow(models), noRepo)
    expect(report).toContain('reads variable REVIEW_CI_BASE_URL and secret REVIEW_CI_API_KEY. Set them')
    expect(report).toContain(`wrote ${callerWorkflowPath}`)
    expect(report).toContain("  gh variable set REVIEW_CI_BASE_URL --body 'https://litellm.example.com'\n  gh secret set REVIEW_CI_API_KEY")
    expect(report).not.toContain('federated credential')
  })

  it('prints the ruleset command requiring the gate, to run once the caller is merged', () => {
    const report = reviewCiReport('wrote', {}, callerWorkflow(models), noRepo)
    expect(report).toContain(`  ${rulesetCommand()}\n`)
    expect(report).toMatch(/only after this workflow is merged to the default branch, or pushes to open PRs get stuck/)
  })
})

describe('rulesetCommand', () => {
  it('posts a ruleset requiring review / gate on the default branch', () => {
    const match = /^echo '(.*)' \| gh api --method POST 'repos\/\{owner\}\/\{repo\}\/rulesets' --input -$/.exec(rulesetCommand())
    expect(JSON.parse(match?.[1] ?? '')).toEqual({
      name: 'yoke review',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        {
          type: 'required_status_checks',
          parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'review / gate' }] },
        },
      ],
    })
  })

  it('prints the federated credential to create instead of the API key command with Entra auth', () => {
    const workflow = callerWorkflow(models, 'foundry', { azureClientId: 'client-1', azureTenantId: 'tenant-1' })
    const report = reviewCiReport('unchanged', {}, workflow, () => 'o/r')
    expect(report).toContain(`kept ${callerWorkflowPath}`)
    expect(report).toContain('reads variable REVIEW_CI_BASE_URL. Set it')
    expect(report).not.toContain('gh secret set REVIEW_CI_API_KEY')
    expect(report).toContain('Entra app client-1')
    expect(report).toContain('  issuer:   https://token.actions.githubusercontent.com')
    expect(report).toContain('  audience: api://AzureADTokenExchange')
    expect(report).toContain('  subject:  repo:o/r:pull_request')
    expect(report).toContain(
      `az ad app federated-credential create --id 'client-1' --parameters '{"name":"yoke-review-ci","issuer":"https://token.actions.githubusercontent.com","subject":"repo:o/r:pull_request","audiences":["api://AzureADTokenExchange"]}'`,
    )
    expect(report).not.toContain('environment')
  })

  it('uses the environment subject and names the environment when one is given', () => {
    const workflow = callerWorkflow(models, 'foundry', { azureClientId: 'client-1', azureTenantId: 'tenant-1', environment: 'review' })
    const report = reviewCiReport('wrote', {}, workflow, () => 'o/r')
    expect(report).toContain('  subject:  repo:o/r:environment:review')
    expect(report).toContain('runs in the review environment')
  })
})
