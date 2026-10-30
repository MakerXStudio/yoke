import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { isSettingKey, settingKeys, type Settings } from './settings'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

type ConfigTree = { [name: string]: unknown }

export function userConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'yoke', 'config.json')
}

function isTree(value: unknown): value is ConfigTree {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getPath(tree: ConfigTree, path: string[]): unknown {
  return path.reduce<unknown>((node, name) => (isTree(node) ? node[name] : undefined), tree)
}

function setPath(tree: ConfigTree, [name = '', ...rest]: string[], value: string): ConfigTree {
  if (!rest.length) return { ...tree, [name]: value }
  const child = tree[name]
  return { ...tree, [name]: setPath(isTree(child) ? child : {}, rest, value) }
}

function readConfigFile(path: string): ConfigTree {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isTree(parsed)) throw new ConfigError(`${path} must be a JSON object`)
  return parsed
}

export function readUserConfig(path: string): Settings {
  const file = readConfigFile(path)
  const settings: Settings = {}
  for (const key of settingKeys) {
    const value = getPath(file, key.split('.'))
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
  const file = setPath(readConfigFile(path), key.split('.'), value)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return `set ${key} in ${path}`
}
