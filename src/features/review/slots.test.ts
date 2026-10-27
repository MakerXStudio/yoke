import { describe, expect, it } from 'vitest'

import { ReviewError } from './pr'
import { resolveSlots } from './slots'

const provider = { 'modelProvider.kind': 'foundry', 'modelProvider.baseUrl': 'https://res', 'modelProvider.apiKey': 'k' }

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
  it('runs each harness on its own auth when no slot names a model, ignoring provider settings', () => {
    expect(resolveSlots({ 'modelProvider.kind': 'bogus' })).toEqual({ claude: { harness: 'claude' }, codex: { harness: 'codex' } })
  })

  it('passes a model to a harness on own auth without needing the provider', () => {
    const slots = resolveSlots({ 'review.reviewer1': 'claude:opus', 'review.reviewer2': 'codex:gpt-5' })
    expect(slots.claude).toEqual({ harness: 'claude', model: 'opus', override: { args: ['--model', 'opus'], env: {} } })
    expect(slots.codex).toEqual({ harness: 'codex', model: 'gpt-5', override: { args: ['-m', 'gpt-5'], env: {} } })
  })

  it('lets a slot swap its harness', () => {
    expect(resolveSlots({ 'review.reviewer1': 'codex' }).claude).toEqual({ harness: 'codex' })
  })

  it('routes an @provider slot through the provider and leaves the rest on own auth', () => {
    const slots = resolveSlots({
      ...provider,
      'review.reviewer2': 'codex:gpt-5-codex@provider',
      'review.synthesis': 'claude:sonnet@provider',
    })
    expect(slots.claude).toEqual({ harness: 'claude' })
    expect(slots.codex).toMatchObject({ harness: 'codex', model: 'gpt-5-codex' })
    expect(slots.codex.override?.args).toContain('model_providers.yoke.base_url=https://res/openai/v1')
    expect(slots.synthesis).toMatchObject({ harness: 'claude', model: 'sonnet' })
    expect(slots.synthesis?.override?.env).toMatchObject({ ANTHROPIC_FOUNDRY_BASE_URL: 'https://res/anthropic' })
  })

  it('names every missing provider setting and how to set it', () => {
    const message = errorOf(() => resolveSlots({ 'review.reviewer1': 'claude:sonnet@provider' }))
    expect(message.split('\n')).toEqual([
      'Review settings are incomplete:',
      '- modelProvider.kind is not set; pass --provider, set YOKE_MODEL_PROVIDER_KIND or run `yoke config set --user modelProvider.kind <litellm|foundry>`',
      '- modelProvider.baseUrl is not set; pass --base-url, set YOKE_MODEL_PROVIDER_BASE_URL or run `yoke config set --user modelProvider.baseUrl <url>`',
      '- modelProvider.apiKey is not set; set YOKE_MODEL_PROVIDER_API_KEY or run `yoke config set --user modelProvider.apiKey <key>`',
    ])
  })

  it('names an unknown provider kind', () => {
    const message = errorOf(() =>
      resolveSlots({ ...provider, 'modelProvider.kind': 'openrouter', 'review.reviewer1': 'claude:sonnet@provider' }),
    )
    expect(message).toContain('- modelProvider.kind "openrouter" must be litellm or foundry; pass --provider')
    expect(message.split('\n')).toHaveLength(2)
  })

  it('names a malformed slot', () => {
    const message = errorOf(() => resolveSlots({ ...provider, 'review.synthesis': 'gpt-5' }))
    expect(message).toContain(
      '- review.synthesis "gpt-5" must be <claude|codex>[:<model>][@provider], with a model when using @provider; pass --synthesis, set YOKE_REVIEW_SYNTHESIS or run `yoke config set --user review.synthesis <harness[:model][@provider]>`',
    )
  })
})
