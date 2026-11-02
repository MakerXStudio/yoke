import { execSync } from 'node:child_process'

import type { InstallType } from './install'
import type { SyncTarget } from './targets'

const packageName = '@makerx/yoke'

type Run = (command: string, cwd?: string) => void

const syncCommands: Record<SyncTarget, string> = { user: 'yoke sync --user', repo: 'yoke sync' }

export const noTargetsMessage =
  "No yoke skills were synced here before, so none were re-synced. Run `yoke sync` for this repo's .claude/skills, or `yoke sync --user` for ~/.claude/skills."

function runInherited(command: string, cwd?: string): void {
  execSync(command, { cwd, stdio: 'inherit' })
}

function installLatest(install: 'git' | 'npm', dir: string, run: Run, log: (line: string) => void): void {
  if (install === 'npm') {
    log('Updating the global npm install...')
    run(`npm i -g ${packageName}@latest`)
    return
  }
  log('Pulling the latest yoke...')
  run('git pull', dir)
  log('Installing dependencies...')
  run('npm i', dir)
  log('Building...')
  run('npm run build', dir)
}

export type UpdateDeps = {
  dir: string
  install: InstallType
  targets: () => SyncTarget[]
  run?: Run
  log: (line: string) => void
  error: (line: string) => void
}

export function updateYoke({ dir, install, targets, run = runInherited, log, error }: UpdateDeps): number {
  log(`yoke is installed at ${dir}`)
  if (install === 'unknown') {
    error(
      `Could not tell how yoke was installed at ${dir}. Expected a git clone or a global npm install; reinstall with \`npm i -g ${packageName}@latest\`.`,
    )
    return 1
  }
  try {
    installLatest(install, dir, run, log)
  } catch {
    error('Updating yoke failed, so no skills were re-synced.')
    return 1
  }
  const found = targets()
  if (found.length === 0) {
    log(noTargetsMessage)
    return 0
  }
  for (const target of found) {
    const command = syncCommands[target]
    log(`Running ${command}...`)
    try {
      run(command)
    } catch {
      error(`${command} failed.`)
      return 1
    }
  }
  return 0
}
