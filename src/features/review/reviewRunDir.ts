import { homedir } from 'node:os'
import { join } from 'node:path'

import type { PullRequest } from './request'

export function reviewRunDir(
  pr: Pick<PullRequest, 'url' | 'number' | 'baseRefOid' | 'headRefOid'>,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const [, owner = '', repo = ''] = new URL(pr.url).pathname.split('/')
  const run = `${pr.number}-${pr.baseRefOid}-${pr.headRefOid}`
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'yoke', 'reviews', owner, repo, run)
}
