import { describe, expect, it } from 'vitest'

import { formatSynthesis, parseSynthesis } from './findings'

const synthesis = `# Code review synthesis

## Summary

Mostly sound; one crash on empty input.

## Findings

### Finding: Style nit
- Severity: nit
- Source: reviewer2-only
- Location: n/a
- Impact: Harder to read.
- Recommendation: Rename it.

### Finding: Crash on empty list
- Severity: Major
- Source: reviewer1-only
- Location: \`src/a.ts:12\`
- Impact: Throws when the list is empty.
- Recommendation: Return early.

### Finding: Off by one
- Severity: major
- Source: confirmed
- Location: \`src/b.ts:40-44\`
- Impact: Drops the last item.
- Recommendation: Use \`<=\`.
`

describe('parseSynthesis', () => {
  it('reads the summary', () => {
    expect(parseSynthesis(synthesis).summary).toBe('Mostly sound; one crash on empty input.')
  })

  it('reads each finding field, splitting the location into file and line', () => {
    expect(parseSynthesis(synthesis).findings).toContainEqual({
      title: 'Crash on empty list',
      severity: 'major',
      source: 'reviewer1-only',
      file: 'src/a.ts',
      line: 12,
      impact: 'Throws when the list is empty.',
      recommendation: 'Return early.',
    })
  })

  it('anchors a line range to its first line', () => {
    expect(parseSynthesis(synthesis).findings.find((f) => f.title === 'Off by one')).toMatchObject({ file: 'src/b.ts', line: 40 })
  })

  it('ranks by severity, then confirmed before single-reviewer findings', () => {
    expect(parseSynthesis(synthesis).findings.map((f) => f.title)).toEqual(['Off by one', 'Crash on empty list', 'Style nit'])
  })

  it('leaves an n/a location empty', () => {
    expect(parseSynthesis(synthesis).findings.at(-1)).toMatchObject({ file: null, line: null })
  })

  it('keeps a file without a line', () => {
    const [finding] = parseSynthesis('### Finding: X\n- Location: `README.md`\n').findings
    expect(finding).toMatchObject({ file: 'README.md', line: null })
  })

  it('ranks a finding with an unknown severity last', () => {
    const markdown = '### Finding: Odd\n- Severity: critical\n\n### Finding: Small\n- Severity: nit\n'
    expect(parseSynthesis(markdown).findings.map((f) => [f.title, f.severity])).toEqual([
      ['Small', 'nit'],
      ['Odd', null],
    ])
  })

  it('returns nothing for markdown without findings', () => {
    expect(parseSynthesis('just prose')).toEqual({ summary: '', findings: [] })
  })
})

describe('formatSynthesis', () => {
  it('prints severity, location and title for each finding', () => {
    const output = formatSynthesis(parseSynthesis(synthesis))
    expect(output).toContain('[major] src/b.ts:40 — Off by one')
    expect(output).toContain('[nit] no location — Style nit')
    expect(output).toContain('  Recommendation: Return early.')
  })

  it('says so when there are no findings', () => {
    expect(formatSynthesis({ summary: 'Clean.', findings: [] })).toBe('Clean.\n\nNo findings.')
  })
})
