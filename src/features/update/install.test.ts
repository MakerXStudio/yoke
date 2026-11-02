import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const execSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execSync }))

const { detectInstall, installDir, isGitClone, isGlobalNpmInstall } = await import('./install')

describe('installDir', () => {
  it('is the package root above the bundled cli', () => {
    expect(installDir('file:///usr/lib/node_modules/@makerx/yoke/dist/cli.js')).toBe(join('/usr/lib/node_modules/@makerx/yoke'))
  })
})

describe('isGlobalNpmInstall', () => {
  it('is true inside node_modules without asking npm', () => {
    const prefix = vi.fn(() => '/elsewhere')
    expect(isGlobalNpmInstall('/home/me/.nvm/versions/node/v24/lib/node_modules/@makerx/yoke', prefix)).toBe(true)
    expect(prefix).not.toHaveBeenCalled()
  })

  it('is true under the npm global prefix', () => {
    expect(isGlobalNpmInstall('/opt/npm-global/yoke', () => '/opt/npm-global')).toBe(true)
  })

  it('is false elsewhere', () => {
    expect(isGlobalNpmInstall('/home/me/git/yoke', () => '/usr/local')).toBe(false)
  })

  it('is false when npm prefix -g fails', () => {
    expect(
      isGlobalNpmInstall('/home/me/git/yoke', () => {
        throw new Error('npm not found')
      }),
    ).toBe(false)
  })

  it('asks npm for the global prefix by default', () => {
    execSync.mockReturnValueOnce(Buffer.from('/opt/npm-global\n'))
    expect(isGlobalNpmInstall('/opt/npm-global/yoke')).toBe(true)
    expect(execSync).toHaveBeenCalledWith('npm prefix -g', { stdio: 'pipe' })
  })
})

describe('isGitClone', () => {
  it('is true when the install dir is the repo toplevel', () => {
    expect(isGitClone('/home/me/git/yoke', () => '/home/me/git/yoke')).toBe(true)
  })

  it('is false when the install dir is nested inside another repo', () => {
    expect(isGitClone('/home/me/node_modules/@makerx/yoke', () => '/home/me')).toBe(false)
  })

  it('is false outside any repo', () => {
    expect(
      isGitClone('/usr/lib/node_modules/@makerx/yoke', () => {
        throw new Error('not a git repository')
      }),
    ).toBe(false)
  })

  it('asks git for the toplevel of the install dir by default', () => {
    execSync.mockReturnValueOnce(Buffer.from('/home/me/git/yoke\n'))
    expect(isGitClone('/home/me/git/yoke')).toBe(true)
    expect(execSync).toHaveBeenCalledWith('git rev-parse --show-toplevel', { cwd: '/home/me/git/yoke', stdio: 'pipe' })
  })
})

function notGit(): string {
  throw new Error('not a git repository')
}

describe('detectInstall', () => {
  it('detects a git clone ahead of the npm check', () => {
    const prefix = vi.fn(() => '/home/me')
    expect(detectInstall('/home/me/git/yoke', prefix, () => '/home/me/git/yoke')).toBe('git')
    expect(prefix).not.toHaveBeenCalled()
  })

  it('detects a global npm install', () => {
    expect(detectInstall('/usr/lib/node_modules/@makerx/yoke', () => '/usr', notGit)).toBe('npm')
  })

  it('is unknown otherwise', () => {
    expect(detectInstall('/home/me/git/yoke', () => '/usr/local', notGit)).toBe('unknown')
  })
})
