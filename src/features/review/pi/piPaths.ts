import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export function resolvePath(cwd: string, path: string): string {
  const bare = path.replace(/^@/, '')
  return isAbsolute(bare) ? bare : resolve(cwd, bare)
}

// Must match pi's resolveToCwd, which its read tool uses to resolve paths.
export function piReadPath(cwd: string, path: string): string {
  const bare = path.replace(/^@/, '')
  const expanded = bare === '~' ? homedir() : bare.startsWith('~/') ? join(homedir(), bare.slice(2)) : bare
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
}
