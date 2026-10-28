import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { ownerMarker } from '../../skill'
import { skillsRoot, syncSkills } from './sync'

let target: string
let destination: string
let skillPath: string

beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), 'yoke-sync-'))
  destination = join(target, '.claude', 'skills')
  skillPath = join(destination, 'pr', 'SKILL.md')
})

afterEach(() => {
  rmSync(target, { recursive: true, force: true })
})

describe('skillsRoot', () => {
  it('targets the repo by default', () => {
    expect(skillsRoot(false, '/repo', '/home/me')).toBe(join('/repo', '.claude', 'skills'))
  })

  it('targets the home directory with --user', () => {
    expect(skillsRoot(true, '/repo', '/home/me')).toBe(join('/home/me', '.claude', 'skills'))
  })
})

describe('syncSkills', () => {
  it.each([
    ['repo', false],
    ['user', true],
  ])('writes the pr skill into the %s .claude/skills', (_, user) => {
    const root = skillsRoot(user, join(target, 'repo'), join(target, 'home'))
    const path = join(root, 'pr', 'SKILL.md')
    expect(syncSkills(root).written).toContain(path)
    expect(readFileSync(path, 'utf8')).toContain('yoke pr raise')
  })

  it('writes skills that yoke owns', () => {
    for (const file of syncSkills(destination).written.filter((f) => f.endsWith('SKILL.md'))) {
      expect(readFileSync(file, 'utf8').split('---')[1]).toContain(ownerMarker)
    }
  })

  it('marks every skill description as coming from yoke', () => {
    for (const file of syncSkills(destination).written) {
      const frontmatter = parse(readFileSync(file, 'utf8').split('---')[1] ?? '')
      expect(frontmatter.description).toMatch(/^\[yoke\] \S/)
    }
  })

  it('lets the model invoke the pr skill', () => {
    syncSkills(destination)
    expect(readFileSync(skillPath, 'utf8')).not.toContain('disable-model-invocation')
  })

  it('overwrites a stale yoke-owned copy of the skill', () => {
    syncSkills(destination)
    writeFileSync(skillPath, `---\nmetadata:\n  ${ownerMarker}\n---\nstale`)
    syncSkills(destination)
    expect(readFileSync(skillPath, 'utf8')).toContain('yoke pr raise')
  })

  it('leaves a user-owned skill of the same name alone', () => {
    mkdirSync(join(destination, 'pr'), { recursive: true })
    writeFileSync(skillPath, 'my own pr skill')
    const result = syncSkills(destination)
    expect(result.skipped).toEqual([join(destination, 'pr')])
    expect(result.written).not.toContain(skillPath)
    expect(readFileSync(skillPath, 'utf8')).toBe('my own pr skill')
  })

  it('leaves other skills and extra files untouched', () => {
    const otherSkill = join(destination, 'mine', 'SKILL.md')
    const extraFile = join(destination, 'pr', 'notes.md')
    mkdirSync(join(destination, 'mine'), { recursive: true })
    writeFileSync(otherSkill, 'mine')
    syncSkills(destination)
    writeFileSync(extraFile, 'notes')
    syncSkills(destination)
    expect(readFileSync(otherSkill, 'utf8')).toBe('mine')
    expect(readFileSync(extraFile, 'utf8')).toBe('notes')
  })
})
