import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { PullRequest } from './request'

export function reviewRunDir(pr: PullRequest, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const [, owner = '', repo = ''] = new URL(pr.url).pathname.split('/')
  const run = `${pr.number}-${pr.baseRefOid}-${pr.headRefOid}`
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'yoke', 'reviews', owner, repo, run)
}

const cachedOutputs = ['reviewer1.md', 'reviewer2.md', 'synthesis.md', 'review.md', 'models.json', 'slots.json']

export function prepareRunDir(reviewDir: string, force: boolean): void {
  mkdirSync(reviewDir, { recursive: true })
  if (force) for (const name of cachedOutputs) rmSync(join(reviewDir, name), { force: true })
}
