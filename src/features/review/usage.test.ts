import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { addUsage, jobSummary, usageTable, writeJobSummary } from './usage'

describe('addUsage', () => {
  it('sums each value, keeping one that only one side reported', () => {
    expect(addUsage({ input: 1, output: 2 }, { input: 10, cacheRead: 5 })).toEqual({ input: 11, output: 2, cacheRead: 5 })
  })

  it('starts from the first reported usage', () => {
    expect(addUsage(undefined, { output: 3 })).toEqual({ output: 3 })
  })
})

describe('usageTable', () => {
  it('has a row per slot and a total, with — for unreported slots and values', () => {
    const table = usageTable({
      reviewer1: { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 800 },
      synthesis: { input: 400, output: 100, cacheRead: 50 },
    })
    expect(table).toBe(
      [
        '## Token usage',
        '',
        '| Slot | Input | Output | Cache read | Cache write |',
        '| --- | ---: | ---: | ---: | ---: |',
        '| Reviewer 1 | 1,200 | 300 | 5,000 | 800 |',
        '| Reviewer 2 | — | — | — | — |',
        '| Synthesis | 400 | 100 | 50 | — |',
        '| **Total** | 1,600 | 400 | 5,050 | 800 |',
      ].join('\n'),
    )
  })

  it('totals — when nothing was reported', () => {
    expect(usageTable({}).split('\n').at(-1)).toBe('| **Total** | — | — | — | — |')
  })
})

describe('writeJobSummary', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yoke-summary-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends the review summary and token usage table', () => {
    const path = join(dir, 'summary.md')
    writeFileSync(path, 'earlier step\n')
    const usage = { reviewer2: { input: 5 } }
    expect(writeJobSummary('One bug.', usage, { GITHUB_STEP_SUMMARY: path })).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(`earlier step\n${jobSummary('One bug.', usage)}\n`)
    expect(jobSummary('One bug.', usage)).toMatch(/^## Adversarial review\n\nOne bug\.\n\n## Token usage\n/)
  })

  it('writes nothing without GITHUB_STEP_SUMMARY', () => {
    expect(writeJobSummary('One bug.', {}, {})).toBe(false)
  })
})
