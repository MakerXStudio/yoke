import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundledSkillsDir = fileURLToPath(new URL('../skills', import.meta.url))

export const ownerMarker = 'owner: "@makerx/yoke"'

export type SyncResult = { written: string[]; skipped: string[] }

export function skillsRoot(user: boolean, cwd = process.cwd(), home = homedir()): string {
  return join(user ? home : cwd, '.claude', 'skills')
}

function isOwnedByUser(skillDir: string): boolean {
  const skillFile = join(skillDir, 'SKILL.md')
  return existsSync(skillFile) && !readFileSync(skillFile, 'utf8').includes(ownerMarker)
}

export function syncSkills(destination: string, skillsDir = bundledSkillsDir): SyncResult {
  const skills = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  const result: SyncResult = { written: [], skipped: [] }
  for (const skill of skills) {
    const source = join(skillsDir, skill.name)
    const target = join(destination, skill.name)
    if (isOwnedByUser(target)) {
      result.skipped.push(target)
      continue
    }
    cpSync(source, target, { recursive: true })
    for (const file of readdirSync(source, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()))
      result.written.push(join(target, relative(source, join(file.parentPath, file.name))))
  }
  return result
}
