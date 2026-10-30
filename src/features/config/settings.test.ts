import { describe, expect, it } from 'vitest'

import { howToSet, listSettings, resolveSettings, settingEnv, settingFlag } from './settings'

function row(output: string, key: string): string | undefined {
  return output.split('\n').find((line) => line.startsWith(`${key} `))
}

describe('listSettings', () => {
  const output = listSettings({
    'litellm.baseUrl': 'https://llm',
    'litellm.apiKey': 'sk-123',
    'review.reviewer2.provider': 'litellm',
  })

  it('shows each value, masks secrets and marks unset settings', () => {
    expect(row(output, 'litellm.baseUrl')).toMatch(/^litellm\.baseUrl +https:\/\/llm$/)
    expect(row(output, 'litellm.apiKey')).toMatch(/^litellm\.apiKey +\*\*\*\*$/)
    expect(row(output, 'review.reviewer2.provider')).toMatch(/^review\.reviewer2\.provider +litellm$/)
    expect(row(output, 'review.reviewer1.harness')).toMatch(/^review\.reviewer1\.harness +<not set>$/)
    expect(output).not.toContain('sk-123')
  })

  it('lists every setting with its description under the value', () => {
    const lines = listSettings({}).split('\n')
    const harness = lines.findIndex((line) => line.startsWith('review.reviewer1.harness'))
    expect(lines[harness + 1]).toBe(`${' '.repeat(27)}claude or codex. Default: claude`)
  })

  it('wraps a description within the terminal, aligned under the value whatever the value length', () => {
    const lines = listSettings({ 'foundry.baseUrl': 'https://a-very-long-resource-name.services.ai.azure.com' }, 50).split('\n')
    const start = lines.findIndex((line) => line.startsWith('review.reviewer1.model'))
    const description = lines.slice(start + 1, lines.indexOf('', start))
    expect(description.length).toBeGreaterThan(1)
    expect(description.every((line) => /^ {27}\S/.test(line) && line.length <= 50)).toBe(true)
  })
})

describe('settingEnv and settingFlag', () => {
  it('derive the env var and flag from the key', () => {
    expect(settingEnv('review.reviewer1.harness')).toBe('YOKE_REVIEW_REVIEWER_1_HARNESS')
    expect(settingFlag('review.reviewer1.harness')).toBe('--reviewer-1-harness')
    expect(settingEnv('litellm.baseUrl')).toBe('YOKE_LITELLM_BASE_URL')
    expect(settingFlag('litellm.baseUrl')).toBe('--litellm-base-url')
  })

  it('gives a secret an env var but no flag', () => {
    expect(settingEnv('foundry.apiKey')).toBe('YOKE_FOUNDRY_API_KEY')
    expect(settingFlag('foundry.apiKey')).toBeUndefined()
  })
})

describe('resolveSettings', () => {
  it('prefers the flag, then the env var, then the user config', () => {
    const settings = resolveSettings(
      { 'litellm.baseUrl': 'https://flag' },
      { YOKE_LITELLM_BASE_URL: 'https://env', YOKE_FOUNDRY_BASE_URL: 'https://foundry-env' },
      { 'litellm.baseUrl': 'https://config', 'foundry.baseUrl': 'https://foundry-config', 'review.synthesis.model': 'opus' },
    )
    expect(settings).toEqual({
      'litellm.baseUrl': 'https://flag',
      'foundry.baseUrl': 'https://foundry-env',
      'review.synthesis.model': 'opus',
    })
  })

  it('reads slot settings from their env vars', () => {
    const settings = resolveSettings(
      {},
      { YOKE_REVIEW_REVIEWER_2_HARNESS: 'claude', YOKE_REVIEW_REVIEWER_2_PROVIDER: 'litellm', YOKE_REVIEW_REVIEWER_2_MODEL: 'gpt-5' },
      {},
    )
    expect(settings).toEqual({
      'review.reviewer2.harness': 'claude',
      'review.reviewer2.provider': 'litellm',
      'review.reviewer2.model': 'gpt-5',
    })
  })

  it('takes a secret from env, then config, never a flag', () => {
    expect(
      resolveSettings({ 'litellm.apiKey': 'flag-key' }, { YOKE_LITELLM_API_KEY: 'env-key' }, { 'litellm.apiKey': 'config-key' }),
    ).toEqual({ 'litellm.apiKey': 'env-key' })
    expect(resolveSettings({ 'foundry.apiKey': 'flag-key' }, {}, {})).toEqual({})
  })

  it('skips blank values', () => {
    expect(
      resolveSettings({ 'review.reviewer1.model': ' ' }, { YOKE_REVIEW_REVIEWER_1_MODEL: '' }, { 'review.reviewer1.model': 'm' }),
    ).toEqual({ 'review.reviewer1.model': 'm' })
  })
})

describe('howToSet', () => {
  it('names the flag, env var and config command', () => {
    expect(howToSet('review.reviewer2.model', '<model>')).toBe(
      'pass --reviewer-2-model, set YOKE_REVIEW_REVIEWER_2_MODEL or run `yoke config set --user review.reviewer2.model <model>`',
    )
  })

  it('offers no flag for an API key', () => {
    expect(howToSet('foundry.apiKey', '<key>')).toBe('set YOKE_FOUNDRY_API_KEY or run `yoke config set --user foundry.apiKey <key>`')
  })
})
