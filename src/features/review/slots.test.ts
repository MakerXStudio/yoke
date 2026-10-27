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

  it('routes a named slot through the provider and leaves the rest on own auth', () => {
    const slots = resolveSlots({ ...provider, 'review.reviewer2': 'codex:gpt-5-codex', 'review.synthesis': 'claude:sonnet' })
    expect(slots.claude).toEqual({ harness: 'claude' })
    expect(slots.codex).toMatchObject({ harness: 'codex', model: 'gpt-5-codex' })
    expect(slots.codex.override?.args).toContain('model_providers.yoke.base_url=https://res/openai/v1')
    expect(slots.synthesis).toMatchObject({ harness: 'claude', model: 'sonnet' })
    expect(slots.synthesis?.override?.env).toMatchObject({ ANTHROPIC_FOUNDRY_BASE_URL: 'https://res/anthropic' })
  })

  it('names every missing provider setting and how to set it', () => {
    const message = errorOf(() => resolveSlots({ 'review.reviewer1': 'claude:sonnet' }))
    expect(message.split('\n')).toEqual([
      'Review settings are incomplete:',
      '- modelProvider.kind is not set; pass --provider, set YOKE_MODEL_PROVIDER_KIND or run `yoke config set --user modelProvider.kind <litellm|foundry>`',
      '- modelProvider.baseUrl is not set; pass --base-url, set YOKE_MODEL_PROVIDER_BASE_URL or run `yoke config set --user modelProvider.baseUrl <url>`',
      '- modelProvider.apiKey is not set; set YOKE_MODEL_PROVIDER_API_KEY or run `yoke config set --user modelProvider.apiKey <key>`',
    ])
  })

  it('names an unknown provider kind', () => {
    const message = errorOf(() => resolveSlots({ ...provider, 'modelProvider.kind': 'openrouter', 'review.reviewer1': 'claude:sonnet' }))
    expect(message).toContain('- modelProvider.kind "openrouter" must be litellm or foundry; pass --provider')
    expect(message.split('\n')).toHaveLength(2)
  })

  it('names a malformed slot', () => {
    const message = errorOf(() => resolveSlots({ ...provider, 'review.synthesis': 'gpt-5' }))
    expect(message).toContain(
      '- review.synthesis "gpt-5" must be claude:<model> or codex:<model>; pass --synthesis, set YOKE_REVIEW_SYNTHESIS or run `yoke config set --user review.synthesis <harness:model>`',
    )
  })
})
