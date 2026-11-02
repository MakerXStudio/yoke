import { describe, expect, it, vi } from 'vitest'

import type { InstallType } from './install'
import type { SyncTarget } from './targets'

const execSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execSync }))

const { noTargetsMessage, updateYoke } = await import('./update')

const dir = '/usr/lib/node_modules/@makerx/yoke'

function deps(overrides: Partial<Parameters<typeof updateYoke>[0]> = {}) {
  const run = vi.fn<(command: string, cwd?: string) => void>()
  const log = vi.fn<(line: string) => void>()
  const error = vi.fn<(line: string) => void>()
  return { dir, install: 'npm' as InstallType, targets: (): SyncTarget[] => [], run, log, error, ...overrides }
}

describe('updateYoke', () => {
  it('updates the global npm install then re-syncs each target with the new binary', () => {
    const run = vi.fn<(command: string) => void>()
    expect(updateYoke(deps({ targets: () => ['user', 'repo'], run }))).toBe(0)
    expect(run.mock.calls.map(([command]) => command)).toEqual(['npm i -g @makerx/yoke@latest', 'yoke sync --user', 'yoke sync'])
  })

  it('looks for sync targets only after installing', () => {
    const order: string[] = []
    const d = deps({ run: vi.fn((command: string) => void order.push(command)), targets: () => (order.push('targets'), ['repo']) })
    updateYoke(d)
    expect(order).toEqual(['npm i -g @makerx/yoke@latest', 'targets', 'yoke sync'])
  })

  it('syncs nothing and says how to sync when no target holds yoke skills', () => {
    const run = vi.fn<(command: string) => void>()
    const d = deps({ run })
    expect(updateYoke(d)).toBe(0)
    expect(run.mock.calls.map(([command]) => command)).toEqual(['npm i -g @makerx/yoke@latest'])
    expect(d.log).toHaveBeenCalledWith(noTargetsMessage)
    expect(noTargetsMessage).toContain('`yoke sync`')
    expect(noTargetsMessage).toContain('`yoke sync --user`')
  })

  it('errors without running anything when the install type is unknown', () => {
    const d = deps({ install: 'unknown', targets: vi.fn(() => ['user' as const]) })
    expect(updateYoke(d)).toBe(1)
    expect(d.run).not.toHaveBeenCalled()
    expect(d.targets).not.toHaveBeenCalled()
    expect(d.error).toHaveBeenCalledWith(expect.stringContaining('Could not tell how yoke was installed'))
  })

  it('stops before syncing when the install fails', () => {
    const d = deps({
      targets: () => ['user'],
      run: vi.fn(() => {
        throw new Error('npm failed')
      }),
    })
    expect(updateYoke(d)).toBe(1)
    expect(d.run).toHaveBeenCalledTimes(1)
    expect(d.error).toHaveBeenCalledWith(expect.stringContaining('no skills were re-synced'))
  })

  it('exits non-zero when a sync fails', () => {
    const d = deps({
      targets: () => ['user', 'repo'],
      run: vi.fn((command: string) => {
        if (command === 'yoke sync --user') throw new Error('sync failed')
      }),
    })
    expect(updateYoke(d)).toBe(1)
    expect(d.run).toHaveBeenCalledTimes(2)
  })

  it('runs commands through child_process with inherited output by default', () => {
    const d = deps()
    delete (d as { run?: unknown }).run
    updateYoke(d)
    expect(execSync).toHaveBeenCalledWith('npm i -g @makerx/yoke@latest', { cwd: undefined, stdio: 'inherit' })
  })
})

describe('updateYoke on a git clone', () => {
  const cloneDir = '/home/me/git/yoke'

  it('pulls, installs and builds in the install dir, then re-syncs with the new binary', () => {
    const run = vi.fn<(command: string, cwd?: string) => void>()
    expect(updateYoke(deps({ dir: cloneDir, install: 'git', targets: () => ['user', 'repo'], run }))).toBe(0)
    expect(run.mock.calls).toEqual([
      ['git pull', cloneDir],
      ['npm i', cloneDir],
      ['npm run build', cloneDir],
      ['yoke sync --user'],
      ['yoke sync'],
    ])
  })

  it('says how to sync when no target holds yoke skills', () => {
    const d = deps({ dir: cloneDir, install: 'git' })
    expect(updateYoke(d)).toBe(0)
    expect(d.run).toHaveBeenCalledTimes(3)
    expect(d.log).toHaveBeenCalledWith(noTargetsMessage)
  })

  it('stops before installing, building or syncing when the pull fails', () => {
    const d = deps({
      dir: cloneDir,
      install: 'git',
      targets: vi.fn(() => ['user' as const]),
      run: vi.fn((command: string) => {
        if (command === 'git pull') throw new Error('pull failed')
      }),
    })
    expect(updateYoke(d)).toBe(1)
    expect(d.run).toHaveBeenCalledTimes(1)
    expect(d.targets).not.toHaveBeenCalled()
    expect(d.error).toHaveBeenCalledWith(expect.stringContaining('no skills were re-synced'))
  })

  it('stops before syncing when the build fails', () => {
    const d = deps({
      dir: cloneDir,
      install: 'git',
      targets: vi.fn(() => ['user' as const]),
      run: vi.fn((command: string) => {
        if (command === 'npm run build') throw new Error('build failed')
      }),
    })
    expect(updateYoke(d)).toBe(1)
    expect(d.run).toHaveBeenCalledTimes(3)
    expect(d.targets).not.toHaveBeenCalled()
  })
})
