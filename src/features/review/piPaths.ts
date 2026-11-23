import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

// How yoke's read_range resolves its path: strip a leading @, no ~ expansion.
export function resolvePath(cwd: string, path: string): string {
  const bare = path.replace(/^@/, '')
  return isAbsolute(bare) ? bare : resolve(cwd, bare)
}

// Mirrors pi's resolveToCwd for its read tool: strip a leading @, expand ~, resolve against cwd.
export function piReadPath(cwd: string, path: string): string {
  const bare = path.replace(/^@/, '')
  const expanded = bare === '~' ? homedir() : bare.startsWith('~/') ? join(homedir(), bare.slice(2)) : bare
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
}
