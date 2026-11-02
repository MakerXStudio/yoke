import { execSync } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type InstallType = 'git' | 'npm' | 'unknown'

export function installDir(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..')
}

function npmGlobalRoot(): string {
  return execSync('npm root -g', { stdio: 'pipe' }).toString().trim()
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

function isInside(parent: string, child: string, platform = process.platform): boolean {
  const fold = (path: string) => (platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))
  const rel = relative(fold(parent), fold(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function isGlobalNpmInstall(dir: string, globalRoot = npmGlobalRoot, platform = process.platform): boolean {
  try {
    return isInside(globalRoot(), dir, platform)
  } catch {
    return false
  }
}

export function detectInstall(dir: string, globalRoot = npmGlobalRoot, toplevel = gitToplevel): InstallType {
  if (isGitClone(dir, toplevel)) return 'git'
  return isGlobalNpmInstall(dir, globalRoot) ? 'npm' : 'unknown'
}
