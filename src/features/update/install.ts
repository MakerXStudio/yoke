import { execSync } from 'node:child_process'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type InstallType = 'git' | 'npm' | 'unknown'

export function installDir(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..')
}

function npmGlobalPrefix(): string {
  return execSync('npm prefix -g', { stdio: 'pipe' }).toString().trim()
}

function gitToplevel(dir: string): string {
  return execSync('git rev-parse --show-toplevel', { cwd: dir, stdio: 'pipe' }).toString().trim()
}

export function isGitClone(dir: string, toplevel = gitToplevel): boolean {
  try {
    return resolve(toplevel(dir)) === resolve(dir)
  } catch {
    return false
  }
}

export function isGlobalNpmInstall(dir: string, globalPrefix = npmGlobalPrefix): boolean {
  const resolved = resolve(dir)
  if (resolved.split(sep).includes('node_modules')) return true
  try {
    return resolved.toLowerCase().startsWith(resolve(globalPrefix()).toLowerCase())
  } catch {
    return false
  }
}

export function detectInstall(dir: string, globalPrefix = npmGlobalPrefix, toplevel = gitToplevel): InstallType {
  if (isGitClone(dir, toplevel)) return 'git'
  return isGlobalNpmInstall(dir, globalPrefix) ? 'npm' : 'unknown'
}
