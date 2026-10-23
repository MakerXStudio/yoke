import { describe, expect, it } from 'vitest'

import { limits, validateBody, validateTitle } from './validate'

const what = 'Retake asks for confirmation before resetting results.'
const why = 'Members lost results by tapping retake by accident.'

function body(sections: Record<string, string>, preamble = ''): string {
  const parts = Object.entries(sections).map(([name, content]) => `## ${name}\n\n${content}`)
  return [preamble, ...parts].filter(Boolean).join('\n\n')
}

function rules(input: string): string[] {
  return validateBody(input).map((v) => v.rule)
}

describe('validateTitle', () => {
  it('accepts a short single-line title', () => {
    expect(validateTitle('feat(retake): confirm before resetting')).toEqual([])
  })

  it('rejects an empty title', () => {
    expect(validateTitle('  ').map((v) => v.rule)).toEqual(['title-required'])
  })

  it('rejects a multi-line title', () => {
    expect(validateTitle('feat: one\nand two').map((v) => v.rule)).toEqual(['title-single-line'])
  })

  it('rejects a title over the cap', () => {
    expect(validateTitle('x'.repeat(limits.title + 1)).map((v) => v.rule)).toEqual(['title-length'])
  })
})

describe('validateBody', () => {
  it('accepts What and Why', () => {
    expect(validateBody(body({ What: what, Why: why }))).toEqual([])
  })

  it('accepts an optional How and Closes lines', () => {
    expect(validateBody(body({ What: what, Why: why, How: 'Reuses the existing dialog.' }, 'Closes #12\nCloses org/repo#3'))).toEqual([])
  })

  it('rejects a body missing What', () => {
    expect(rules(body({ Why: why }))).toEqual(['what-required'])
  })

  it('rejects a body missing Why', () => {
    expect(rules(body({ What: what }))).toEqual(['why-required'])
  })

  it('rejects an empty required section', () => {
    expect(rules(body({ What: what, Why: '' }))).toEqual(['why-required'])
  })

  it('rejects an unknown section', () => {
    expect(rules(body({ What: what, Why: why, Summary: 'More words.' }))).toEqual(['unknown-section'])
  })

  it('rejects a known name at the wrong heading level', () => {
    expect(rules(`### What\n\n${what}\n\n## Why\n\n${why}`)).toEqual(['unknown-section', 'what-required'])
  })

  it('rejects sections out of order', () => {
    expect(rules(body({ Why: why, What: what }))).toEqual(['section-order'])
  })

  it('rejects a duplicated section', () => {
    expect(rules(`## What\n\n${what}\n\n## Why\n\n${why}\n\n## What\n\nAgain.`)).toEqual(['duplicate-section'])
  })

  it('rejects prose before What', () => {
    expect(rules(body({ What: what, Why: why }, 'This PR does things.'))).toEqual(['preamble'])
  })

  it('rejects a section over its cap', () => {
    const violations = validateBody(body({ What: 'x'.repeat(limits.sections.What + 1), Why: why }))
    expect(violations.map((v) => v.rule)).toEqual(['section-length'])
    expect(violations[0]?.message).toContain('## What')
  })

  it('rejects a body over the total cap even when each section fits', () => {
    const sections = { What: 'x'.repeat(limits.sections.What), Why: 'y'.repeat(limits.sections.Why), How: 'z'.repeat(150) }
    expect(rules(body(sections))).toEqual(['body-length'])
  })

  it('rejects a per-file change list', () => {
    const list = '- `src/retake.ts`: adds the dialog\n- `src/results.ts`: guards the reset'
    expect(rules(body({ What: what, Why: why, How: list }))).toEqual(['per-file-list'])
  })

  it('rejects a per-file list of bare paths', () => {
    const list = '* Updated src/retake.ts\n* Updated src/results.ts\n* Updated docs/retake.md'
    expect(rules(body({ What: what, Why: why, How: list }))).toEqual(['per-file-list'])
  })

  it('allows a bullet list that does not name files', () => {
    const list = '- Retake\n- Reset\n- Results, e.g. scores'
    expect(validateBody(body({ What: what, Why: why, How: list }))).toEqual([])
  })

  it('reports every failed rule at once', () => {
    expect(rules('Some intro.\n\n## Changes\n\nStuff.')).toEqual(['preamble', 'unknown-section', 'what-required', 'why-required'])
  })
})
