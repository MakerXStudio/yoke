import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { findingMarker, type PriorComment } from './comments'
import { parseSynthesis } from './findings'
import type { Harness, HarnessResult, HarnessRun } from './harness'
import { type PostDeps, postFindings } from './post'
import { ReviewError } from './pr'
import type { PullRequest } from './request'
import { reviewRunDir } from './review'
import { type ReviewContext, runReview } from './run'
import type { ReviewSlots } from './slots'
import { lineUi } from './status'

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
  const { log, track } = lineUi((line) => logs.push(line), { activity: true })
  return {
    cwd: '/repo',
    reviewDir,
    slots,
    log,
    track,
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
    expect(logs).toContain('claude reviewer (codex:gpt-5-codex)…')
    expect(logs).toContain('synthesis (claude:sonnet)…')
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

  it('reuses a cached review and reruns synthesis when a reviewer had to run', async () => {
    writeFileSync(join(reviewDir, 'claude.md'), 'cached claude review')
    writeFileSync(join(reviewDir, 'synthesis.md'), 'stale synthesis')
    const { report } = await runReview('request', context())
    expect(runs.map((r) => r.outputPath.split('/').at(-1))).toEqual(['codex.md', 'synthesis.md'])
    expect(logs).toContain('claude reviewer: cached')
    expect(report).toContain('Crash')
  })

  it('reuses the cached synthesis when every reviewer was cached', async () => {
    writeFileSync(join(reviewDir, 'claude.md'), 'claude')
    writeFileSync(join(reviewDir, 'codex.md'), 'codex')
    writeFileSync(join(reviewDir, 'synthesis.md'), synthesis)
    await runReview('request', context())
    expect(runs).toEqual([])
    expect(logs).toContain('synthesis (claude): cached')
  })

  it('does not cache the output of a failed reviewer', async () => {
    const failing = context()
    await runReview('request', {
      ...failing,
      runHarness: async (run) => {
        if (run.harness !== 'codex' || run.outputPath.endsWith('synthesis.md')) return failing.runHarness(run)
        writeFileSync(run.outputPath, 'partial')
        return { ok: false, error: 'down' }
      },
    })
    expect(existsSync(join(reviewDir, 'codex.md'))).toBe(false)
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

  const review = { id: 7, nodeId: 'PRR_7' }

  function fakeApi(overrides: Partial<PostDeps['api']> = {}) {
    return {
      open: vi.fn<PostDeps['api']['open']>(async () => review),
      add: vi.fn<PostDeps['api']['add']>(async () => {}),
      submit: vi.fn<PostDeps['api']['submit']>(async () => 'https://github.com/o/r/pull/4#pullrequestreview-7'),
      discard: vi.fn<PostDeps['api']['discard']>(async () => {}),
      ...overrides,
    }
  }

  async function post(markdown: string, api = fakeApi(), prior: PriorComment[] = []) {
    await postFindings(pr, parseSynthesis(markdown), diff, prior, { api, log: (line) => logs.push(line) })
    return api
  }

  it('adds each inline comment to one pending review, then submits it with the body', async () => {
    const api = await post(synthesis)
    expect(api.open).toHaveBeenCalledTimes(1)
    expect(api.add).toHaveBeenCalledWith(review, { path: 'src/a.ts', line: 3, body: expect.stringContaining('**major: Crash**') })
    expect(api.submit).toHaveBeenCalledWith(pr, review, '## Adversarial review\n\nOne bug.')
    expect(logs).toContain('posted 1 inline comment(s) and 0 in the review body: https://github.com/o/r/pull/4#pullrequestreview-7')
  })

  it('moves a comment GitHub rejects into the review body', async () => {
    const api = await post(
      synthesis,
      fakeApi({
        add: vi.fn(async () => {
          throw new ReviewError('line must be part of the diff')
        }),
      }),
    )
    expect(api.submit).toHaveBeenCalledWith(pr, review, expect.stringContaining('### Findings outside the diff'))
    expect(api.submit).toHaveBeenCalledWith(pr, review, expect.stringContaining('`src/a.ts:3` — Crash'))
    expect(logs).toContain('GitHub rejected the comment on src/a.ts:3, so it goes in the review body: line must be part of the diff')
    expect(logs).toContain('posted 0 inline comment(s) and 1 in the review body: https://github.com/o/r/pull/4#pullrequestreview-7')
  })

  it('discards the pending review when submitting fails', async () => {
    const api = fakeApi({
      submit: vi.fn(async () => {
        throw new ReviewError('boom')
      }),
    })
    await expect(post(synthesis, api)).rejects.toThrow('boom')
    expect(api.discard).toHaveBeenCalledWith(pr, review)
  })

  it('keeps the submit error when discarding also fails', async () => {
    const api = fakeApi({
      submit: vi.fn(async () => {
        throw new ReviewError('boom')
      }),
      discard: vi.fn(async () => {
        throw new ReviewError('gone')
      }),
    })
    await expect(post(synthesis, api)).rejects.toThrow('boom')
    expect(logs).toContain('could not discard the pending review: gone')
  })

  it('does not open a review when every finding was already raised', async () => {
    const api = await post(synthesis, fakeApi(), [
      { path: 'src/a.ts', line: 3, author: 'me', body: `old\n\n${findingMarker({ file: 'src/a.ts', title: 'Crash' })}` },
    ])
    expect(api.open).not.toHaveBeenCalled()
    expect(logs).toEqual(['skipped 1 finding(s) already raised on the PR', 'nothing new to post'])
  })
})

describe('reviewRunDir', () => {
  const pr: PullRequest = { number: 4, title: 't', baseRefName: 'main', baseRefOid: 'b', headRefName: 'f', headRefOid: 'abc', files: [] }

  it('keys the run by PR number and head commit under the XDG cache', () => {
    expect(reviewRunDir(pr, { XDG_CACHE_HOME: '/cache' }, '/home/me')).toBe(join('/cache', 'yoke', 'reviews', '4-abc'))
  })

  it('defaults to ~/.cache', () => {
    expect(reviewRunDir(pr, {}, '/home/me')).toBe(join('/home/me', '.cache', 'yoke', 'reviews', '4-abc'))
  })
})
