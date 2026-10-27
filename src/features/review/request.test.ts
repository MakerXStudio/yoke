import { describe, expect, it } from 'vitest'

import { buildRequest, commentableLines, type PullRequest, withNewFileLineNumbers } from './request'

const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -3,3 +10,3 @@ fn', ' keep', '-gone', '+added', ' tail'].join('\n')

describe('withNewFileLineNumbers', () => {
  it('numbers added and context lines from the hunk start and leaves removed lines blank', () => {
    expect(withNewFileLineNumbers(diff).split('\n').slice(4)).toEqual(['    10   keep', '        -gone', '    11  +added', '    12   tail'])
  })

  it('leaves headers blank', () => {
    expect(withNewFileLineNumbers(diff).split('\n').slice(0, 4)).toEqual([
      '        diff --git a/x.ts b/x.ts',
      '        --- a/x.ts',
      '        +++ b/x.ts',
      '        @@ -3,3 +10,3 @@ fn',
    ])
  })
})

describe('buildRequest', () => {
  const pr: PullRequest = {
    number: 7,
    title: 'feat: x',
    baseRefName: 'main',
    baseRefOid: 'aaa',
    headRefName: 'feature',
    headRefOid: 'bbb',
    files: [{ path: 'x.ts' }],
  }

  it('lists the PR, its changed files and the numbered diff', () => {
    const request = buildRequest(pr, diff)
    expect(request).toContain('- PR: #7 feat: x')
    expect(request).toContain('- x.ts')
    expect(request).toContain('    11  +added')
    expect(request).not.toContain('Prior review comments')
  })

  it('appends the prior review comments after the diff', () => {
    const request = buildRequest(pr, diff, [{ path: 'x.ts', line: 11, author: 'wade', body: 'Guard this.' }])
    expect(request).toMatch(/```\n\n## Prior review comments\n[\s\S]*### x\.ts:11\n\n\*\*wade\*\*: Guard this\.\n$/)
  })
})

describe('commentableLines', () => {
  it('maps each file to its added and context lines in the new file', () => {
    expect(commentableLines(diff)).toEqual(new Map([['x.ts', new Set([10, 11, 12])]]))
  })

  it('leaves out deleted files', () => {
    expect(commentableLines(['+++ /dev/null', '@@ -1 +0,0 @@', '-gone'].join('\n'))).toEqual(new Map())
  })
})
