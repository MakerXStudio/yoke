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
  callerWorkflowPath,
  renderCallerWorkflow,
  repoRoot,
  reviewCiReport,
  reviewWorkflowRef,
  secretCommands,
  writeCallerWorkflow,
} from './ci'

const workflowSchema = z.object({
  on: z.record(
    z.string(),
    z.object({
      types: z.array(z.string()).optional(),
      inputs: z.record(z.string(), z.object({ required: z.boolean().optional() })).optional(),
      secrets: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  jobs: z.record(
    z.string(),
    z.object({
      uses: z.string().optional(),
      with: z.record(z.string(), z.string()).optional(),
      secrets: z.record(z.string(), z.string()).optional(),
    }),
  ),
})

type Workflow = z.infer<typeof workflowSchema>

const reusable = workflowSchema.parse(parse(readFileSync(join(import.meta.dirname, '../../../.github/workflows/review.yml'), 'utf8')))

const models: Settings = { 'review.reviewer1.model': 'bedrock/claude-opus-5-5', 'review.reviewer2.model': 'azure/gpt-6.1-sol' }

function generated(settings: Settings = models, provider?: string): Workflow {
  return workflowSchema.parse(parse(renderCallerWorkflow(callerWorkflow(settings, provider))))
}

function inputsOf(settings: Settings = models, provider?: string): Record<string, string> {
  return generated(settings, provider).jobs.review?.with ?? {}
}

describe('callerWorkflow', () => {
  it('calls the reusable review workflow on new and ready PRs', () => {
    const workflow = generated()
    expect(workflow.on.pull_request?.types).toEqual(['opened', 'reopened', 'ready_for_review'])
    expect(workflow.jobs.review?.uses).toBe(reviewWorkflowRef)
  })

  it('passes only the review secrets, never every repository secret', () => {
    expect(generated().jobs.review?.secrets).toEqual({
      REVIEW_CI_BASE_URL: '${{ secrets.REVIEW_CI_BASE_URL }}',
      REVIEW_CI_API_KEY: '${{ secrets.REVIEW_CI_API_KEY }}',
    })
  })

  it('passes only inputs the reusable workflow declares, including every required one', () => {
    const declared = reusable.on.workflow_call?.inputs ?? {}
    const passed = inputsOf({ ...models, 'review.synthesis.harness': 'codex', 'review.synthesis.model': 'azure/gpt-6.1-sol' })
    expect(Object.keys(declared)).toEqual(expect.arrayContaining(Object.keys(passed)))
    const required = Object.entries(declared).flatMap(([name, input]) => (input.required ? [name] : []))
    expect(Object.keys(passed)).toEqual(expect.arrayContaining(required))
  })

  it('passes exactly the secrets the reusable workflow reads', () => {
    expect(Object.keys(reusable.on.workflow_call?.secrets ?? {}).toSorted()).toEqual(
      Object.keys(generated().jobs.review?.secrets ?? {}).toSorted(),
    )
  })

  it('defaults to litellm with claude and codex reviewers', () => {
    expect(inputsOf()).toEqual({
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

describe('secretCommands', () => {
  it('fills in the base URL the provider is configured with', () => {
    expect(secretCommands({ 'litellm.baseUrl': 'https://litellm.example.com' }, 'litellm')).toEqual([
      "gh secret set REVIEW_CI_BASE_URL --body 'https://litellm.example.com'",
      'gh secret set REVIEW_CI_API_KEY',
    ])
  })

  it('prompts for the base URL when it is not configured', () => {
    expect(secretCommands({ 'litellm.baseUrl': 'https://litellm.example.com' }, 'foundry')[0]).toBe('gh secret set REVIEW_CI_BASE_URL')
  })

  it('never puts the API key on the command line', () => {
    expect(secretCommands({ 'litellm.apiKey': 'sk-secret' }, 'litellm').join('\n')).not.toContain('sk-secret')
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

describe('reviewCiReport', () => {
  it('lists the workflow and each secret command', () => {
    const report = reviewCiReport('wrote', ['gh secret set A', 'gh secret set B'])
    expect(report).toContain(`wrote ${callerWorkflowPath}`)
    expect(report).toContain('  gh secret set A\n  gh secret set B')
  })
})
