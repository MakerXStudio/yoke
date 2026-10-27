import { describe, expect, it } from 'vitest'

import { findingMarker, type PriorComment } from './comments'
import type { Finding } from './findings'
import { planPost, reviewBody, withoutReviewerNames } from './post'

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,3 @@',
  ' keep',
  '-gone',
  '+added',
  ' tail',
  'diff --git a/old.ts b/old.ts',
  '--- a/old.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-removed',
].join('\n')

function finding(overrides: Partial<Finding>): Finding {
  return {
    title: 'Bug',
    severity: 'major',
    source: 'claude-only',
    file: 'src/a.ts',
    line: 11,
    impact: 'Breaks.',
    recommendation: 'Fix.',
    ...overrides,
  }
}

function plan(findings: Finding[], prior: PriorComment[] = []) {
  return planPost({ summary: 's', findings }, diff, prior)
}

describe('planPost', () => {
  it('anchors a finding on an added line to that line', () => {
    expect(plan([finding({})]).comments).toEqual([
      {
        path: 'src/a.ts',
        line: 11,
        body: `**major: Bug**\n\nImpact: Breaks.\n\nRecommendation: Fix.\n\n<!-- yoke-review: src/a.ts#bug -->`,
        finding: finding({}),
      },
    ])
  })

  it('anchors a finding on a context line', () => {
    expect(plan([finding({ line: 12 })]).comments.map((c) => c.line)).toEqual([12])
  })

  it('puts findings outside the diff, in files not in it, or without a location in the body', () => {
    const outside = [
      finding({ line: 13 }),
      finding({ file: 'src/other.ts' }),
      finding({ file: 'old.ts', line: 1 }),
      finding({ file: null, line: null }),
    ]
    expect(plan(outside)).toMatchObject({ comments: [], outside, skipped: [] })
  })

  it('skips findings the synthesis marked already raised', () => {
    const raised = finding({ source: 'already-raised' })
    expect(plan([raised])).toMatchObject({ comments: [], outside: [], skipped: [raised] })
  })

  it('skips findings yoke already posted, by file and title, even after the line moved', () => {
    const prior: PriorComment[] = [
      { path: 'src/a.ts', line: 30, author: 'me', body: `**major: Bug**\n\n${findingMarker({ file: 'src/a.ts', title: 'Bug' })}` },
    ]
    expect(plan([finding({})], prior).skipped).toHaveLength(1)
  })

  it('skips an out-of-diff finding yoke already put in a review body', () => {
    const outside = finding({ file: null, line: null, title: 'Docs drift' })
    const prior: PriorComment[] = [
      { path: null, line: null, author: 'me', body: `- **major** no location — Docs drift\n  <!-- yoke-review: n/a#docs-drift -->` },
    ]
    expect(plan([outside], prior).skipped).toEqual([outside])
  })

  it('posts a finding whose title differs from the one already posted on that file', () => {
    const prior: PriorComment[] = [{ path: 'src/a.ts', line: 11, author: 'me', body: findingMarker({ file: 'src/a.ts', title: 'Other' }) }]
    expect(plan([finding({})], prior).comments).toHaveLength(1)
  })
})

describe('reviewBody', () => {
  it('lists findings outside the diff under the summary, each with its marker', () => {
    expect(
      reviewBody('Summary.', [
        finding({ line: 40 }),
        finding({ file: null, line: null, title: 'Loose', severity: null, impact: '', recommendation: '' }),
      ]),
    ).toBe(
      [
        '## Adversarial review',
        '',
        'Summary.',
        '',
        '### Findings outside the diff',
        '',
        '- **major** `src/a.ts:40` — Bug',
        '  Impact: Breaks.',
        '  Recommendation: Fix.',
        '  <!-- yoke-review: src/a.ts#bug -->',
        '- **finding** no location — Loose',
        '  <!-- yoke-review: n/a#loose -->',
      ].join('\n'),
    )
  })

  it('is just the heading and summary when every finding is inline', () => {
    expect(reviewBody('Summary.', [])).toBe('## Adversarial review\n\nSummary.')
  })

  it('ends with the footer, which keeps its model names', () => {
    expect(reviewBody('Claude found one bug.', [], '---\n_by yoke with claude-opus-4-1._')).toBe(
      '## Adversarial review\n\nthe reviewer found one bug.\n\n---\n_by yoke with claude-opus-4-1._',
    )
  })

  it('names no reviewer, even with no summary', () => {
    expect(reviewBody('', [])).toBe('## Adversarial review')
    expect(reviewBody('The codex review is missing, so this rests on Claude alone.', [])).toBe(
      '## Adversarial review\n\nthe reviewer review is missing, so this rests on the reviewer alone.',
    )
  })
})

describe('withoutReviewerNames', () => {
  it.each([
    ['Claude flagged it', 'the reviewer flagged it'],
    ['both opus and gpt-5.1-codex agree', 'both the reviewer and the reviewer agree'],
    ['a Codex run', 'the reviewer run'],
    ['claudette and codexes stay', 'claudette and codexes stay'],
  ])('rewrites %s', (input, expected) => {
    expect(withoutReviewerNames(input)).toBe(expected)
  })

  it('keeps reviewer names out of inline comments but keeps the marker stable', () => {
    const { comments } = plan([finding({ title: 'Claude found a bug', impact: 'Codex agrees.' })])
    expect(comments[0]?.body).toBe(
      [
        '**major: the reviewer found a bug**',
        'Impact: the reviewer agrees.',
        'Recommendation: Fix.',
        '<!-- yoke-review: src/a.ts#claude-found-a-bug -->',
      ].join('\n\n'),
    )
  })
})
