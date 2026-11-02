import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { ownerMarker, type Skill } from '../../skill'
import { bundledSkills, skillsRoot } from '../sync/sync'

export type SyncTarget = 'user' | 'repo'

function holdsYokeSkill(root: string, skills: Skill[]): boolean {
  return skills.some((skill) => {
    if (skill.userLevel) return false
    const file = join(root, skill.name, 'SKILL.md')
    return existsSync(file) && readFileSync(file, 'utf8').includes(ownerMarker)
  })
}

export function syncTargets(cwd = process.cwd(), home = homedir(), skills = bundledSkills): SyncTarget[] {
  const userRoot = skillsRoot(true, cwd, home)
  const repoRoot = skillsRoot(false, cwd, home)
  const targets: SyncTarget[] = []
  if (holdsYokeSkill(userRoot, skills)) targets.push('user')
  if (resolve(repoRoot) !== resolve(userRoot) && holdsYokeSkill(repoRoot, skills)) targets.push('repo')
  return targets
}
