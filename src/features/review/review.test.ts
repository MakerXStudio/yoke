import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { findingMarker, type PriorComment } from './comments'
import { parseSynthesis } from './findings'
import type { Harness, HarnessResult, HarnessRun } from './harness'
import { ReviewError } from './pr'
import type { PullRequest } from './request'
import { type PostDeps, postFindings, type ReviewContext, runReview, savedReviewPath } from './review'
import type { ReviewSlots } from './slots'

const synthesis = `## Summary

One bug.

## Findings

### Finding: Crash
- Severity: major
- Source: claude-only
- Location: \`src/a.ts:3\`
- Impact: Throws.
- Recommendation: Guard it.
`

const ownAuth: ReviewSlots = { claude: { harness: 'claude' }, codex: { harness: 'codex' } }

type Fake = { reviews?: Partial<Record<Harness, string | Error>>; synthesis?: string | Error }

let reviewDir: string
let runs: HarnessRun[]
let logs: string[]

beforeEach(() => {
  reviewDir = mkdtempSync(join(tmpdir(), 'yoke-review-test-'))
  runs = []
  logs = []
})

afterEach(() => {
  rmSync(reviewDir, { recursive: true, force: true })
})

function context({ reviews = {}, synthesis: synthesised = synthesis }: Fake = {}, slots = ownAuth): ReviewContext {
  return {
    cwd: '/repo',
    reviewDir,
    slots,
    log: (line) => logs.push(line),
    runHarness: async (run): Promise<HarnessResult> => {
      runs.push(run)
      const output = run.outputPath.endsWith('synthesis.md') ? synthesised : (reviews[run.harness] ?? `${run.harness} says hi`)
      if (output instanceof Error) return { ok: false, error: output.message }
      writeFileSync(run.outputPath, output)
      return { ok: true }
    },
  }
}

describe('runReview', () => {
  it('runs both reviewers before synthesis and prints the ranked findings', async () => {
    const { report: output, synthesis: parsed } = await runReview('request', context())
    expect(runs.map((r) => [r.harness, r.outputPath.split('/').at(-1)])).toEqual([
      ['claude', 'claude.md'],
      ['codex', 'codex.md'],
      ['claude', 'synthesis.md'],
    ])
    expect(output).toContain('[major] src/a.ts:3 — Crash')
    expect(parsed?.findings.map((f) => f.title)).toEqual(['Crash'])
  })

  it('starts the reviewers in parallel', async () => {
    const started: Harness[] = []
    let release: (() => void) | undefined
    const bothStarted = new Promise<void>((resolve) => (release = resolve))
    const base = context()
    const review = runReview('request', {
      ...base,
      runHarness: async (run) => {
        if (!run.outputPath.endsWith('synthesis.md')) {
          started.push(run.harness)
          if (started.length === 2) release?.()
          await bothStarted
        }
        return base.runHarness(run)
      },
    })
    await expect(review).resolves.toMatchObject({ report: expect.stringContaining('Crash') })
    expect(started).toEqual(['claude', 'codex'])
  })

  it('names a failed reviewer and synthesises the other on its own harness', async () => {
    const { report: output } = await runReview('request', context({ reviews: { claude: new Error('claude CLI not found on PATH') } }))
    expect(logs).toContainEqual(expect.stringMatching(/^claude reviewer failed after \d+s: claude CLI not found on PATH$/))
    const synthesisRun = runs.at(-1)
    expect(synthesisRun?.harness).toBe('codex')
    expect(synthesisRun?.prompt).toContain('- claude review: missing')
    expect(synthesisRun?.prompt).toContain(`- codex review: ${join(reviewDir, 'codex.md')}`)
    expect(output).toContain('Crash')
  })

  it('runs each slot on its own harness and override, naming the model', async () => {
    const override = { args: ['-m', 'gpt-5-codex'], env: { KEY: 'k' } }
    const slots: ReviewSlots = {
      claude: { harness: 'codex', model: 'gpt-5-codex', override },
      codex: { harness: 'codex' },
      synthesis: { harness: 'claude', model: 'sonnet', override: { args: ['--model', 'sonnet'], env: {} } },
    }
    await runReview('request', context({}, slots))
    expect(runs.map((r) => [r.harness, r.outputPath.split('/').at(-1), r.override?.args])).toEqual([
      ['codex', 'claude.md', ['-m', 'gpt-5-codex']],
      ['codex', 'codex.md', undefined],
      ['claude', 'synthesis.md', ['--model', 'sonnet']],
    ])
    expect(logs).toContain('claude reviewer (codex:gpt-5-codex) running…')
    expect(logs).toContain('synthesis (claude:sonnet) running…')
  })

  it('runs an unset synthesis slot on the first successful reviewer harness without its override', async () => {
    const slots: ReviewSlots = {
      claude: { harness: 'claude' },
      codex: { harness: 'codex', model: 'm', override: { args: ['-m', 'm'], env: {} } },
    }
    await runReview('request', context({ reviews: { claude: new Error('down') } }, slots))
    expect(runs.at(-1)).toMatchObject({ harness: 'codex', override: undefined })
  })

  it('fails when every reviewer fails', async () => {
    const review = runReview('request', context({ reviews: { claude: new Error('down'), codex: new Error('down') } }))
    await expect(review).rejects.toThrow(ReviewError)
    expect(runs).toHaveLength(2)
  })

  it('shows the raw reviews when synthesis fails', async () => {
    const { report: output, synthesis: parsed } = await runReview(
      'request',
      context({ reviews: { codex: new Error('down') }, synthesis: new Error('boom') }),
    )
    expect(output).toBe('# claude review\n\nclaude says hi')
    expect(parsed).toBeNull()
  })

  it('shows synthesis output that is not in the findings format as is', async () => {
    expect(await runReview('request', context({ synthesis: 'Free-form review.\n' }))).toEqual({
      report: 'Free-form review.',
      synthesis: null,
      markdown: null,
    })
  })
})

describe('postFindings', () => {
  const pr: PullRequest = {
    number: 4,
    title: 't',
    baseRefName: 'main',
    baseRefOid: 'base',
    headRefName: 'feature',
    headRefOid: 'head',
    files: [],
  }
  const diff = ['+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' one', '+two', ' three'].join('\n')

  function post(markdown: string, prior: PriorComment[] = []) {
    const submit = vi.fn<PostDeps['submit']>(() => 'https://github.com/o/r/pull/4#pullrequestreview-1')
    postFindings(pr, parseSynthesis(markdown), diff, prior, { submit, log: (line) => logs.push(line) })
    return submit
  }

  it('submits one review with the inline comments and the body', () => {
    const submit = post(synthesis)
    expect(submit).toHaveBeenCalledTimes(1)
    const [, body, comments] = submit.mock.calls[0] ?? []
    expect(body).toBe('One bug.')
    expect(comments).toEqual([{ path: 'src/a.ts', line: 3, body: expect.stringContaining('**major: Crash**') }])
    expect(logs).toContain('posted 1 inline comment(s) and 0 in the review body: https://github.com/o/r/pull/4#pullrequestreview-1')
  })

  it('does not submit when every finding was already raised', () => {
    const submit = post(synthesis, [
      { path: 'src/a.ts', line: 3, author: 'me', body: `old\n\n${findingMarker({ file: 'src/a.ts', title: 'Crash' })}` },
    ])
    expect(submit).not.toHaveBeenCalled()
    expect(logs).toEqual(['skipped 1 finding(s) already raised on the PR', 'nothing new to post'])
  })
})

describe('savedReviewPath', () => {
  const pr: PullRequest = { number: 4, title: 't', baseRefName: 'main', baseRefOid: 'b', headRefName: 'f', headRefOid: 'abc', files: [] }

  it('keys the saved review by PR number and head commit under the XDG cache', () => {
    expect(savedReviewPath(pr, { XDG_CACHE_HOME: '/cache' }, '/home/me')).toBe(join('/cache', 'yoke', 'reviews', '4-abc.md'))
  })

  it('defaults to ~/.cache', () => {
    expect(savedReviewPath(pr, {}, '/home/me')).toBe(join('/home/me', '.cache', 'yoke', 'reviews', '4-abc.md'))
  })
})
