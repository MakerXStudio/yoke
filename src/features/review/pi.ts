import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type PiModel, piModels } from './provider'

const piFlags = [
  '--mode',
  'json',
  '--no-session',
  '--no-approve',
  '--no-extensions',
  '--no-mcp',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
]

function extensionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const built = join(here, 'piExtension.js')
  return existsSync(built) ? built : join(here, 'piExtension.ts')
}

export const piExtension = extensionPath()

export function piAgentDir(env: NodeJS.ProcessEnv, home = homedir()): string {
  const dir = env.PI_CODING_AGENT_DIR
  if (!dir) return join(home, '.pi', 'agent')
  return dir === '~' ? home : dir.replace(/^~(?=[/\\])/, home)
}

export function pathKey(env: NodeJS.ProcessEnv): string {
  if ('PATH' in env) return 'PATH'
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function hasCommand(names: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const windows = platform === 'win32'
  const dirs = [join(piAgentDir(env), 'bin'), ...(env[pathKey(env)] ?? '').split(windows ? ';' : ':').filter(Boolean)]
  const found = (path: string) => (windows ? existsSync(`${path}.exe`) : isExecutable(path))
  return dirs.some((dir) => names.some((name) => found(join(dir, name))))
}

function piTools(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const grep = hasCommand(['rg'], env, platform) ? ['grep'] : []
  const find = hasCommand(['fd', 'fdfind'], env, platform) ? ['find'] : []
  return ['read', 'ls', 'git', 'read_range', ...grep, ...find].join(',')
}

export function piArgs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, extra: string[]): string[] {
  return [...piFlags, '-e', piExtension, '--tools', piTools(env, platform), ...extra]
}

export function createPiAgentDir(pi: PiModel | undefined): string | undefined {
  if (!pi) return undefined
  const dir = mkdtempSync(join(tmpdir(), 'yoke-pi-'))
  try {
    writeFileSync(join(dir, 'models.json'), JSON.stringify(piModels(pi), null, 2))
  } catch (error) {
    removeDir(dir)
    throw error
  }
  return dir
}

export function removeDir(dir: string | undefined): void {
  try {
    if (dir) rmSync(dir, { recursive: true, force: true })
  } catch {}
}

export function piEnv(env: NodeJS.ProcessEnv, agentDir: string | undefined): NodeJS.ProcessEnv {
  const pi = { ...env, PI_OFFLINE: '1', PI_TELEMETRY: '0' }
  if (!agentDir) return pi
  const key = pathKey(env)
  const path = [env[key], join(piAgentDir(env), 'bin')].filter(Boolean).join(delimiter)
  return { ...pi, [key]: path, PI_CODING_AGENT_DIR: agentDir }
}
