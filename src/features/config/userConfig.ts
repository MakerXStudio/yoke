import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { isSettingKey, type SettingKey, settingKeys, type Settings } from './settings'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

type ConfigFile = Record<string, Record<string, unknown>>

export function userConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'yoke', 'config.json')
}

function isConfigFile(value: unknown): value is ConfigFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((section) => typeof section === 'object' && section !== null && !Array.isArray(section))
  )
}

function readConfigFile(path: string): ConfigFile {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isConfigFile(parsed)) throw new ConfigError(`${path} must be a JSON object of setting sections`)
  return parsed
}

function splitKey(key: SettingKey): [string, string] {
  const dot = key.indexOf('.')
  return [key.slice(0, dot), key.slice(dot + 1)]
}

export function readUserConfig(path: string): Settings {
  const file = readConfigFile(path)
  const settings: Settings = {}
  for (const key of settingKeys) {
    const [section, name] = splitKey(key)
    const value = file[section]?.[name]
    if (typeof value === 'string') settings[key] = value
  }
  return settings
}

export function setSetting(key: string, value: string, user: boolean, path: string): string {
  if (!user)
    throw new ConfigError(
      'Repo-level config is not supported: it would put the API key in the repo. Pass --user to write the user-level yoke config.',
    )
  if (!isSettingKey(key)) throw new ConfigError(`Unknown setting "${key}"; expected one of: ${settingKeys.join(', ')}`)
  const file = readConfigFile(path)
  const [section, name] = splitKey(key)
  file[section] = { ...file[section], [name]: value }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return `set ${key} in ${path}`
}
