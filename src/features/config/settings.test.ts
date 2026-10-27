import { describe, expect, it } from 'vitest'

import { howToSet, listSettings, resolveSettings } from './settings'

describe('listSettings', () => {
  it('lists every key with its value, masking secrets and marking unset keys', () => {
    const lines = listSettings({ 'modelProvider.kind': 'litellm', 'modelProvider.apiKey': 'sk-123', 'review.reviewer2': 'codex:gpt-5' })
      .split('\n')
      .filter((line) => /^\S/.test(line))
      .slice(0, 6)
    expect(lines).toEqual([
      'modelProvider.kind     litellm',
      'modelProvider.baseUrl  <not set>',
      'modelProvider.apiKey   ****',
      'review.reviewer1       <not set>',
      'review.reviewer2       codex:gpt-5',
      'review.synthesis       <not set>',
    ])
  })

  it('puts each description under its value and ends with example slot values', () => {
    const output = listSettings({})
    expect(output).toContain('review.reviewer1       <not set>\n                       First reviewer. Default: claude on your own login')
    expect(output).toContain('  codex:gpt-5@provider    codex through the model provider, using gpt-5')
  })

  it('wraps a description within the terminal, aligned under the value whatever the value length', () => {
    const lines = listSettings({ 'modelProvider.baseUrl': 'https://a-very-long-resource-name.services.ai.azure.com' }, 70).split('\n')
    const baseUrl = lines.findIndex((line) => line.startsWith('modelProvider.baseUrl'))
    const end = lines.indexOf('', baseUrl)
    const description = lines.slice(baseUrl + 1, end)
    expect(description.length).toBeGreaterThan(1)
    expect(description.every((line) => /^ {23}\S/.test(line) && line.length <= 70)).toBe(true)
  })

  it('marks an unset secret as not set', () => {
    expect(listSettings({})).toContain('modelProvider.apiKey   <not set>')
  })
})

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
