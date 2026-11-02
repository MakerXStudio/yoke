import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ownerMarker } from '../../skill'
import { syncTargets } from './targets'

let base: string
let home: string
let repo: string

function writeSkill(root: string, name: string, owned = true): void {
  const dir = join(root, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), owned ? `---\nmetadata:\n  ${ownerMarker}\n---\n` : '---\nname: mine\n---\n')
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'yoke-update-'))
  home = join(base, 'home')
  repo = join(base, 'repo')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('syncTargets', () => {
  it('finds nothing when no skills were synced', () => {
    expect(syncTargets(repo, home)).toEqual([])
  })

  it('targets --user when ~/.claude/skills holds a yoke skill', () => {
    writeSkill(home, 'pr')
    expect(syncTargets(repo, home)).toEqual(['user'])
  })

  it('targets the repo when its .claude/skills holds a yoke skill', () => {
    writeSkill(repo, 'review')
    expect(syncTargets(repo, home)).toEqual(['repo'])
  })

  it('targets both when both hold yoke skills', () => {
    writeSkill(home, 'review')
    writeSkill(repo, 'pr')
    expect(syncTargets(repo, home)).toEqual(['user', 'repo'])
  })

  it('ignores a lone user-level review-ci, which every sync writes to ~/.claude/skills', () => {
    writeSkill(home, 'review-ci')
    expect(syncTargets(repo, home)).toEqual([])
  })

  it('ignores same-named skills yoke did not write', () => {
    writeSkill(home, 'pr', false)
    writeSkill(repo, 'review', false)
    expect(syncTargets(repo, home)).toEqual([])
  })

  it('targets only --user when run from the home directory', () => {
    writeSkill(home, 'pr')
    expect(syncTargets(home, home)).toEqual(['user'])
  })
})
