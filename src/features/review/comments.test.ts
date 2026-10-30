import { describe, expect, it } from 'vitest'

import { findingMarker, formatPriorComments } from './comments'

describe('findingMarker', () => {
  it('keys a finding by file and slugged title', () => {
    expect(findingMarker({ file: 'src/a.ts', title: 'Crash on `empty` list!' })).toBe('<!-- yoke-review: src/a.ts#crash-on-empty-list -->')
  })
})

describe('formatPriorComments', () => {
  it('is empty when the PR has no comments', () => {
    expect(formatPriorComments([])).toBe('')
  })

  it('lists inline and review-body comments by location and author, without yoke markers', () => {
    const section = formatPriorComments([
      { path: 'src/a.ts', line: 3, author: 'wade', body: 'Guard this.' },
      { path: 'src/b.ts', line: null, author: 'rob', body: 'File-level.' },
      { path: null, line: null, author: 'me', body: `Summary.\n  ${findingMarker({ file: null, title: 'X' })}` },
    ])
    expect(section).toContain('## Prior review comments')
    expect(section).toContain('### src/a.ts:3\n\n**wade**: Guard this.')
    expect(section).toContain('### src/b.ts\n\n**rob**: File-level.')
    expect(section).toContain('### PR review\n\n**me**: Summary.')
    expect(section).not.toContain('yoke-review')
  })
})
