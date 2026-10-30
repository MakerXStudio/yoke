import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { logged, reviewLog } from './reviewLog'
import { lineUi } from './status'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yoke-review-log-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = () => readFileSync(join(dir, 'review.log'), 'utf8')

describe('reviewLog', () => {
  it('writes lines buffered before the review folder is known under a header, then appends', () => {
    const file = reviewLog(['review', '9'], () => new Date('2026-10-28T00:00:00Z'))
    file.append('fetching PR #9…')
    file.attach(dir)
    file.append('claude reviewer done in 3s')
    expect(read()).toBe('\n=== 2026-10-28T00:00:00.000Z ===\n$ yoke review 9\nfetching PR #9…\nclaude reviewer done in 3s\n')
  })

  it('appends each run to the same file', () => {
    reviewLog(['review'], () => new Date('2026-10-28T00:00:00Z')).attach(dir)
    reviewLog(['review'], () => new Date('2026-10-28T01:00:00Z')).attach(dir)
    expect(read().match(/^=== /gm)).toHaveLength(2)
  })
})

describe('logged', () => {
  it('keeps tool activity in the log even when the screen leaves it out', () => {
    const shown: string[] = []
    const file = reviewLog(['review'])
    const ui = logged(
      lineUi((line) => shown.push(line), { activity: false }),
      file.append,
    )
    file.attach(dir)
    const status = ui.track('codex reviewer')
    status.update('shell rg foo')
    status.succeed('codex reviewer done in 5s')
    expect(shown).toEqual(['codex reviewer…', 'codex reviewer done in 5s'])
    expect(read()).toContain('codex reviewer…\ncodex reviewer: shell rg foo\ncodex reviewer done in 5s\n')
  })
})
