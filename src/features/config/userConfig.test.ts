import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfigError, readUserConfig, setSetting, userConfigPath } from './userConfig'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yoke-config-test-'))
  path = join(dir, 'yoke', 'config.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('userConfigPath', () => {
  it('lives under XDG_CONFIG_HOME, or ~/.config', () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/me')).toBe(join('/xdg', 'yoke', 'config.json'))
    expect(userConfigPath({}, '/home/me')).toBe(join('/home/me', '.config', 'yoke', 'config.json'))
  })
})

describe('setSetting', () => {
  it('rejects a call without --user and writes nothing', () => {
    expect(() => setSetting('litellm.apiKey', 'secret', false, path)).toThrow(/Repo-level config is not supported/)
    expect(existsSync(path)).toBe(false)
  })

  it('rejects an unknown key', () => {
    expect(() => setSetting('modelProvider.kind', 'x', true, path)).toThrow(ConfigError)
    expect(existsSync(path)).toBe(false)
  })

  it('writes settings that readUserConfig reads back, keeping earlier ones', () => {
    setSetting('litellm.baseUrl', 'https://llm', true, path)
    setSetting('litellm.apiKey', 'secret', true, path)
    setSetting('review.reviewer2.provider', 'litellm', true, path)
    setSetting('review.reviewer2.model', 'gpt-5-codex', true, path)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      litellm: { baseUrl: 'https://llm', apiKey: 'secret' },
      review: { reviewer2: { provider: 'litellm', model: 'gpt-5-codex' } },
    })
    expect(readUserConfig(path)).toEqual({
      'litellm.baseUrl': 'https://llm',
      'litellm.apiKey': 'secret',
      'review.reviewer2.provider': 'litellm',
      'review.reviewer2.model': 'gpt-5-codex',
    })
  })

  it.skipIf(process.platform === 'win32')('keeps the file private to the user', () => {
    setSetting('litellm.apiKey', 'secret', true, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('readUserConfig', () => {
  it('is empty when the file is missing', () => {
    expect(readUserConfig(path)).toEqual({})
  })

  it('names a malformed file', () => {
    const file = join(dir, 'bad.json')
    writeFileSync(file, '{')
    expect(() => readUserConfig(file)).toThrow(`${file} is not valid JSON`)
  })
})
