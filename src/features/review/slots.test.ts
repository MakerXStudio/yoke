import { describe, expect, it } from 'vitest'

import { ReviewError } from './pr'
import { resolveSlots } from './slots'

const foundry = { 'foundry.baseUrl': 'https://res', 'foundry.apiKey': 'k' }

function errorOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof ReviewError) return error.message
    throw error
  }
  throw new Error('expected a ReviewError')
}

describe('resolveSlots', () => {
  it('runs claude and codex on your own login when no slot is set, ignoring provider settings', () => {
    expect(resolveSlots({ 'litellm.baseUrl': 'https://llm' })).toEqual({
      claude: { harness: 'claude' },
      codex: { harness: 'codex' },
      synthesis: undefined,
    })
  })

  it('passes a model to a harness on your own login when no provider is set', () => {
    const slots = resolveSlots({ 'review.reviewer1.model': 'opus', 'review.reviewer2.model': 'gpt-5' })
    expect(slots.claude).toEqual({ harness: 'claude', model: 'opus', override: { args: ['--model', 'opus'], env: {} } })
    expect(slots.codex).toEqual({ harness: 'codex', model: 'gpt-5', override: { args: ['-m', 'gpt-5'], env: {} } })
  })

  it('lets a slot swap its harness', () => {
    expect(resolveSlots({ 'review.reviewer1.harness': 'codex' }).claude).toEqual({ harness: 'codex' })
  })

  it('routes a slot with a provider through it and leaves the rest on your own login', () => {
    const slots = resolveSlots({
      ...foundry,
      'review.reviewer2.provider': 'foundry',
      'review.reviewer2.model': 'gpt-5-codex',
      'review.synthesis.provider': 'foundry',
      'review.synthesis.model': 'sonnet',
    })
    expect(slots.claude).toEqual({ harness: 'claude' })
    expect(slots.codex).toMatchObject({ harness: 'codex', model: 'gpt-5-codex', provider: 'foundry' })
    expect(slots.codex.override?.args).toContain('model_providers.yoke.base_url=https://res/openai/v1')
    expect(slots.synthesis).toMatchObject({ harness: 'claude', model: 'sonnet', provider: 'foundry' })
    expect(slots.synthesis?.override?.env).toMatchObject({ ANTHROPIC_FOUNDRY_BASE_URL: 'https://res/anthropic' })
  })

  it("runs a synthesis slot without a harness on the first reviewer's CLI", () => {
    const slots = resolveSlots({ 'review.reviewer1.harness': 'codex', 'review.synthesis.model': 'gpt-5' })
    expect(slots.synthesis).toMatchObject({ harness: 'codex', model: 'gpt-5' })
  })

  it('names every missing setting of the provider a slot uses, and how to set it', () => {
    const message = errorOf(() => resolveSlots({ 'review.reviewer1.provider': 'litellm', 'review.reviewer1.model': 'sonnet' }))
    expect(message.split('\n')).toEqual([
      'Review settings are incomplete:',
      '- litellm.baseUrl is not set; pass --litellm-base-url, set YOKE_LITELLM_BASE_URL or run `yoke config set --user litellm.baseUrl <url>`',
      '- litellm.apiKey is not set; set YOKE_LITELLM_API_KEY or run `yoke config set --user litellm.apiKey <key>`',
    ])
  })

  it('requires a model with a provider', () => {
    const message = errorOf(() => resolveSlots({ ...foundry, 'review.reviewer2.provider': 'foundry' }))
    expect(message).toContain(
      '- review.reviewer2.model is required when review.reviewer2.provider is set; pass --reviewer-2-model, set YOKE_REVIEW_REVIEWER_2_MODEL or run `yoke config set --user review.reviewer2.model <model>` (see `yoke models`)',
    )
  })

  it('names an unknown harness and provider', () => {
    const message = errorOf(() => resolveSlots({ 'review.synthesis.harness': 'gemini', 'review.synthesis.provider': 'openrouter' }))
    expect(message).toContain('- review.synthesis.harness "gemini" must be claude or codex; pass --synthesis-harness')
    expect(message).toContain('- review.synthesis.provider "openrouter" must be litellm or foundry; pass --synthesis-provider')
  })
})
