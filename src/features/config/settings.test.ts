import { describe, expect, it } from 'vitest'

import { howToSet, resolveSettings } from './settings'

describe('resolveSettings', () => {
  it('prefers the flag, then the env var, then the user config', () => {
    const settings = resolveSettings(
      { 'modelProvider.kind': 'foundry' },
      { YOKE_MODEL_PROVIDER_KIND: 'litellm', YOKE_MODEL_PROVIDER_BASE_URL: 'https://env' },
      { 'modelProvider.kind': 'config', 'modelProvider.baseUrl': 'https://config', 'review.synthesis': 'claude:opus' },
    )
    expect(settings).toEqual({
      'modelProvider.kind': 'foundry',
      'modelProvider.baseUrl': 'https://env',
      'review.synthesis': 'claude:opus',
    })
  })

  it('reads every reviewer slot from its env var', () => {
    const settings = resolveSettings(
      {},
      { YOKE_REVIEW_REVIEWER_1: 'claude:a', YOKE_REVIEW_REVIEWER_2: 'codex:b', YOKE_REVIEW_SYNTHESIS: 'claude:c' },
      {},
    )
    expect(settings).toEqual({ 'review.reviewer1': 'claude:a', 'review.reviewer2': 'codex:b', 'review.synthesis': 'claude:c' })
  })

  it('takes the API key from env, then config', () => {
    expect(resolveSettings({}, { YOKE_MODEL_PROVIDER_API_KEY: 'env-key' }, { 'modelProvider.apiKey': 'config-key' })).toEqual({
      'modelProvider.apiKey': 'env-key',
    })
    expect(resolveSettings({}, {}, { 'modelProvider.apiKey': 'config-key' })).toEqual({ 'modelProvider.apiKey': 'config-key' })
  })

  it('skips blank values', () => {
    expect(resolveSettings({ 'review.reviewer1': ' ' }, { YOKE_REVIEW_REVIEWER_1: '' }, { 'review.reviewer1': 'codex:m' })).toEqual({
      'review.reviewer1': 'codex:m',
    })
  })
})

describe('howToSet', () => {
  it('names the flag, env var and config command', () => {
    expect(howToSet('modelProvider.baseUrl', '<url>')).toBe(
      'pass --base-url, set YOKE_MODEL_PROVIDER_BASE_URL or run `yoke config set --user modelProvider.baseUrl <url>`',
    )
  })

  it('offers no flag for the API key', () => {
    expect(howToSet('modelProvider.apiKey', '<key>')).toBe(
      'set YOKE_MODEL_PROVIDER_API_KEY or run `yoke config set --user modelProvider.apiKey <key>`',
    )
  })
})
