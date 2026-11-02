import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ownerMarker, renderSkill, type Skill } from '../../skill'
import { prSkill } from '../pr/skill'
import { reviewCiSkill } from '../review/ciSkill'
import { reviewSkill } from '../review/skill'

export const bundledSkills: Skill[] = [prSkill, reviewSkill, reviewCiSkill]

export type SyncResult = { written: string[]; skipped: string[] }

export function skillsRoot(user: boolean, cwd = process.cwd(), home = homedir()): string {
  return join(user ? home : cwd, '.claude', 'skills')
}

function isOwnedByUser(skillFile: string): boolean {
  return existsSync(skillFile) && !readFileSync(skillFile, 'utf8').includes(ownerMarker)
}

export function syncSkills(destination: string, userDestination: string, force = false, skills = bundledSkills): SyncResult {
  const result: SyncResult = { written: [], skipped: [] }
  for (const skill of skills) {
    const target = join(skill.userLevel ? userDestination : destination, skill.name)
    const skillFile = join(target, 'SKILL.md')
    if (!force && isOwnedByUser(skillFile)) {
      result.skipped.push(target)
      continue
    }
    mkdirSync(target, { recursive: true })
    writeFileSync(skillFile, renderSkill(skill))
    result.written.push(skillFile)
  }
  return result
}
