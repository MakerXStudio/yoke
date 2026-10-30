import { describe, expect, it } from 'vitest'

import { buildRequest, commentableLines, type PullRequest, withNewFileLineNumbers } from './request'

const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -3,3 +10,3 @@ fn', ' keep', '-gone', '+added', ' tail'].join('\n')

const lookalikes = ['--- a/x.md', '+++ b/x.md', '@@ -1,3 +1,3 @@', ' intro', '--- old', '+++ heading', ' outro'].join('\n')

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

  it('numbers an added line that looks like a file header', () => {
    expect(withNewFileLineNumbers(lookalikes).split('\n').slice(3)).toEqual([
      '     1   intro',
      '        --- old',
      '     2  +++ heading',
      '     3   outro',
    ])
  })
})

describe('buildRequest', () => {
  const pr: PullRequest = {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
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

  it('keeps an added line that looks like a file header in its own file', () => {
    expect(commentableLines(lookalikes)).toEqual(new Map([['x.md', new Set([1, 2, 3])]]))
  })

  it('reads the next file once a hunk is used up', () => {
    const two = [diff, '--- a/y.ts', '+++ b/y.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n')
    expect(commentableLines(two)).toEqual(
      new Map([
        ['x.ts', new Set([10, 11, 12])],
        ['y.ts', new Set([1])],
      ]),
    )
  })

  it('decodes a path git quoted and strips its b/ prefix', () => {
    const quoted = ['+++ "b/caf\\303\\251\\tmenu.md"', '@@ -0,0 +1 @@', '+hi'].join('\n')
    expect(commentableLines(quoted)).toEqual(new Map([['café\tmenu.md', new Set([1])]]))
  })

  it('leaves out deleted files', () => {
    expect(commentableLines(['+++ /dev/null', '@@ -1 +0,0 @@', '-gone'].join('\n'))).toEqual(new Map())
  })
})
