import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'

import type { Settings } from '../config/settings'
import {
  callerTargetTypes,
  callerWorkflow,
  callerTriggerTypes,
  callerWorkflowPath,
  type EntraFlags,
  gateCheck,
  renderCallerWorkflow,
  editInPlaceMessage,
  repoRoot,
  reviewCiReport,
  reviewWorkflowRef,
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
      steps: z.array(z.object({ name: z.string().optional(), if: z.string().optional(), run: z.string().optional() })).optional(),
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

  it('runs the approved review when a fork PR is labelled, and withdraws the approval when it is pushed to', () => {
    expect(generated().on.pull_request_target?.types).toEqual(['labeled', 'synchronize'])
  })

  it('lets the gate read earlier runs, record approved reviews and re-run the gate', () => {
    expect(generated().permissions).toEqual({ actions: 'write', contents: 'read', 'pull-requests': 'write', statuses: 'write' })
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

  const runs = Object.values(stepsSchema.parse(parse(reusableSource)).jobs).flatMap((job) => job.steps.flatMap((step) => step.run ?? []))

  it('keeps logic in yoke, not in run scripts', () => {
    for (const run of runs) expect(run.trim().split('\n').length, run).toBeLessThanOrEqual(2)
  })

  it('installs no package by name, only from the lockfile', () => {
    for (const run of runs) {
      expect(run, run).not.toMatch(/\bnpx\b|\bnpm\s+(install|i|add|exec|x)\b|\b(yarn|pnpm|bun)x?\b/)
    }
    expect(reusableSource).not.toMatch(/CLAUDE_CODE_VERSION|CODEX_VERSION/)
  })

  it('runs npm ci against yoke checked out at the commit the caller resolved, in every job', () => {
    const jobSchema = z.object({
      steps: z.array(
        z.object({ uses: z.string().optional(), with: z.record(z.string(), z.unknown()).optional(), run: z.string().optional() }),
      ),
    })
    const jobs = z.object({ jobs: z.record(z.string(), jobSchema) }).parse(parse(reusableSource)).jobs
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.steps, name).toContainEqual(
        expect.objectContaining({
          with: expect.objectContaining({
            repository: 'MakerXStudio/yoke',
            ref: '${{ job.workflow_sha }}',
            'sparse-checkout': 'ci/review-tools',
          }),
        }),
      )
      expect(
        job.steps.some((step) => step.run?.split('\n')[0]?.trim().startsWith('npm ci')),
        name,
      ).toBe(true)
    }
    expect(
      jobs.gate?.steps.some((step) => step.run?.split('\n')[0]?.trim() === 'npm ci --omit=optional'),
      'the gate only runs yoke, so it skips the Claude Code and Codex platform binaries',
    ).toBe(true)
  })

  it('locks no optional package for yoke, so omitting optional deps keeps all of it', () => {
    const lock = z
      .object({ packages: z.record(z.string(), z.object({ optional: z.boolean().optional() })) })
      .parse(JSON.parse(readFileSync(join(import.meta.dirname, '../../../ci/review-tools/package-lock.json'), 'utf8')))
    const optional = Object.entries(lock.packages).flatMap(([path, entry]) => (entry.optional ? [path] : []))
    expect(optional.length).toBeGreaterThan(0)
    for (const path of optional) expect(path, path).toMatch(/^node_modules\/(@anthropic-ai\/claude-code|@openai\/codex)-/)
  })
})

describe('review tools lockfile', () => {
  const toolsDir = join(import.meta.dirname, '../../../ci/review-tools')
  const manifest = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync(join(toolsDir, 'package.json'), 'utf8')))
  const lock = z
    .object({ packages: z.record(z.string(), z.object({ version: z.string().optional(), integrity: z.string().optional() })) })
    .parse(JSON.parse(readFileSync(join(toolsDir, 'package-lock.json'), 'utf8')))
  const installed = Object.entries(lock.packages).filter(([path]) => path !== '')

  it('pins yoke, Claude Code and Codex to exact versions', () => {
    expect(Object.keys(manifest.dependencies).toSorted()).toEqual(['@anthropic-ai/claude-code', '@makerx/yoke', '@openai/codex'])
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/)
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version)
    }
  })

  it('has a sha512 integrity hash for every package', () => {
    expect(installed.length).toBeGreaterThan(0)
    for (const [path, entry] of installed) expect(entry.integrity, path).toMatch(/^sha512-/)
  })

  it('locks each released yoke version exactly after a release', () => {
    const release = readFileSync(join(import.meta.dirname, '../../../.github/workflows/release.yml'), 'utf8')
    expect(release).toContain('working-directory: ci/review-tools')
    expect(release).toContain('npm install --package-lock-only --save-exact "@makerx/yoke@$version"')
    expect(release).toMatch(/git commit -m "chore: /)
  })

  it('exposes the ruleset-bypassing App token only to the step that pushes the lock', () => {
    const release = z
      .object({ jobs: z.object({ release: z.object({ steps: z.array(z.record(z.string(), z.unknown())) }) }) })
      .parse(parse(readFileSync(join(import.meta.dirname, '../../../.github/workflows/release.yml'), 'utf8')))
    const steps = release.jobs.release.steps
    const usesToken = steps.filter((step) => JSON.stringify(step).includes('steps.app-token.outputs.token'))
    expect(usesToken.map((step) => step.name)).toEqual(['Lock released yoke for CI review'])
    const mint = steps.findIndex((step) => step.id === 'app-token')
    expect(steps[mint + 1]?.name).toBe('Lock released yoke for CI review')
  })

  it('has Dependabot bump Claude Code and Codex but not yoke', () => {
    const dependabot = z
      .object({
        updates: z.array(
          z.object({
            'package-ecosystem': z.string(),
            directory: z.string(),
            ignore: z.array(z.object({ 'dependency-name': z.string() })).optional(),
          }),
        ),
      })
      .parse(parse(readFileSync(join(import.meta.dirname, '../../../.github/dependabot.yml'), 'utf8')))
    const tools = dependabot.updates.find((update) => update.directory === '/ci/review-tools')
    expect(tools?.['package-ecosystem']).toBe('npm')
    expect(tools?.ignore?.map((rule) => rule['dependency-name'])).toEqual(['@makerx/yoke'])
  })
})

describe('gate', () => {
  it('runs after the review whatever its result, and on pull_request_target only after an approved review', () => {
    expect(reusable.jobs.gate).toMatchObject({
      needs: 'review',
      if: "always() && (github.event_name == 'pull_request' || needs.review.result != 'skipped')",
    })
  })

  it('skips the review on pushes, and runs it on pull_request_target only for a fork labelled review', () => {
    const condition = reusable.jobs.review?.if ?? ''
    expect(condition).toMatch(/^github\.event\.action != 'synchronize' && /)
    expect(condition).toContain("github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository")
    expect(condition).toContain(
      "github.event_name == 'pull_request_target' && github.event.action == 'labeled' && github.event.label.name == 'review' && github.event.pull_request.head.repo.full_name != github.repository",
    )
  })

  it('removes the review label only on a push to a labelled fork PR', () => {
    const { unapprove } = reusable.jobs
    expect(unapprove?.if).toBe(
      "github.event_name == 'pull_request_target' && github.event.action == 'synchronize' && github.event.pull_request.head.repo.full_name != github.repository && contains(github.event.pull_request.labels.*.name, 'review')",
    )
    expect(unapprove?.needs).toBeUndefined()
    expect(reusableSource).toContain('run: yoke review unapprove')
  })

  it('reviews only the approved head on pull_request_target', () => {
    expect(reusableSource).toContain(
      "APPROVED_HEAD: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || '' }}",
    )
    expect(reusableSource).toContain('${APPROVED_HEAD:+--head "$APPROVED_HEAD"}')
  })

  it('marks an approved review as running before it starts', () => {
    const steps = reusable.jobs.review?.steps ?? []
    const pending = steps.findIndex((step) => step.run?.includes('review gate pending'))
    expect(steps[pending]?.if).toBe("github.event_name == 'pull_request_target'")
    expect(pending).toBeLessThan(steps.findIndex((step) => step.name === 'Review PR'))
  })

  it('checks out the trusted base on pull_request_target, so npm and npx never read fork config', () => {
    expect(reusableSource).toContain("ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || '' }}")
  })

  it("triggers yoke's own review like the generated caller", () => {
    expect(ownCaller.on.pull_request?.types).toEqual(callerTriggerTypes)
    expect(ownCaller.on.pull_request_target?.types).toEqual(callerTargetTypes)
    expect(ownCaller.permissions).toEqual(generated().permissions)
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
    expect(rendered).toContain(
      'permissions:\n  actions: write\n  contents: read\n  pull-requests: write\n  statuses: write\n  id-token: write\n',
    )
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
    expect(writeCallerWorkflow(root, 'content')).toBe('wrote')
    expect(readFileSync(join(root, callerWorkflowPath), 'utf8')).toBe('content')
    expect(writeCallerWorkflow(root, 'content')).toBe('unchanged')
  })

  it('never overwrites a different workflow and says to edit it in place', () => {
    writeCallerWorkflow(root, 'mine')
    expect(() => writeCallerWorkflow(root, 'yoke')).toThrow(editInPlaceMessage)
    expect(editInPlaceMessage).toContain('Edit it in place')
    expect(editInPlaceMessage).toContain('yoke review ci --print')
    expect(editInPlaceMessage).not.toContain('--force')
    expect(readFileSync(join(root, callerWorkflowPath), 'utf8')).toBe('mine')
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
    expect(report).toContain('from the repo variable REVIEW_CI_BASE_URL and its API key from the secret REVIEW_CI_API_KEY. Set them')
    expect(report).toContain(`Added ${callerWorkflowPath}`)
    expect(report).toContain(
      "  gh variable set REVIEW_CI_BASE_URL --body 'https://litellm.example.com'\n  gh secret set REVIEW_CI_API_KEY\nSkip the secret if REVIEW_CI_API_KEY is already set for your organisation.",
    )
    expect(report).not.toContain('federated credential')
  })

  it('points to /review-ci-gate, once the caller is merged, instead of printing a ruleset command', () => {
    for (const outcome of ['wrote', 'unchanged', 'printed'] as const) {
      const report = reviewCiReport(outcome, {}, callerWorkflow(models), noRepo)
      expect(report).toContain('run /review-ci-gate once this workflow is merged to the default branch')
      expect(report).not.toContain('gh api')
      expect(report).not.toContain('rulesets')
    }
  })

  it('says what happens to the repo without naming flags', () => {
    const settings = { 'litellm.baseUrl': 'https://litellm.example.com' }
    for (const outcome of ['wrote', 'unchanged', 'printed'] as const) {
      const prose = reviewCiReport(outcome, settings, callerWorkflow(models), noRepo)
      expect(prose).not.toMatch(/--(?!body)\w/)
    }
    expect(reviewCiReport('unchanged', settings, callerWorkflow(models), noRepo)).toContain('already matches')
  })

  it('prints the workflow and setup commands without claiming a write', () => {
    const workflow = callerWorkflow(models)
    const report = reviewCiReport('printed', { 'litellm.baseUrl': 'https://litellm.example.com' }, workflow, noRepo)
    expect(report).toContain(`yoke's version of ${callerWorkflowPath}, not saved to the repo:`)
    expect(report).toContain(renderCallerWorkflow(workflow).trimEnd())
    expect(report).toContain("  gh variable set REVIEW_CI_BASE_URL --body 'https://litellm.example.com'\n  gh secret set REVIEW_CI_API_KEY")
    expect(report).not.toContain(`Added ${callerWorkflowPath}`)
    expect(report).not.toContain('already matches')
  })

  it('prints the federated credential to create instead of the API key command with Entra auth', () => {
    const workflow = callerWorkflow(models, 'foundry', { azureClientId: 'client-1', azureTenantId: 'tenant-1' })
    const report = reviewCiReport('unchanged', {}, workflow, () => 'o/r')
    expect(report).toContain(`${callerWorkflowPath} already matches`)
    expect(report).toContain('from the repo variable REVIEW_CI_BASE_URL. Set it')
    expect(report).not.toContain('REVIEW_CI_API_KEY')
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
