import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ownerMarker, renderSkill, type Skill } from '../../skill'
import { prSkill } from '../pr/skill'

const bundledSkills: Skill[] = [prSkill]

export type SyncResult = { written: string[]; skipped: string[] }

export function skillsRoot(user: boolean, cwd = process.cwd(), home = homedir()): string {
  return join(user ? home : cwd, '.claude', 'skills')
}

function isOwnedByUser(skillFile: string): boolean {
  return existsSync(skillFile) && !readFileSync(skillFile, 'utf8').includes(ownerMarker)
}

export function syncSkills(destination: string, skills = bundledSkills): SyncResult {
  const result: SyncResult = { written: [], skipped: [] }
  for (const skill of skills) {
    const target = join(destination, skill.name)
    const skillFile = join(target, 'SKILL.md')
    if (isOwnedByUser(skillFile)) {
      result.skipped.push(target)
      continue
    }
    mkdirSync(target, { recursive: true })
    writeFileSync(skillFile, renderSkill(skill))
    result.written.push(skillFile)
  }
  return result
}
