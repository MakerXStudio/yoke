import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { GateContext } from './gate'
import type * as Pr from './pr'
import { githubGet } from './pr'
import { pushReview, runPushReview } from './pushReview'

vi.mock('./pr', async (actual) => ({ ...(await actual<typeof Pr>()), githubGet: vi.fn() }))

type Job = { name: string; status: string; conclusion: string | null }

const pullRequest = { number: 5, head: { ref: 'feature', sha: 'abcdef123', repo: { full_name: 'o/r' } }, user: { type: 'User' } }

function context(action = 'synchronize', eventName: GateContext['eventName'] = 'pull_request'): GateContext {
  return {
    repo: 'o/r',
    runId: '900',
    runNumber: 10,
    serverUrl: 'https://github.com',
    eventName,
    event: { action, pull_request: pullRequest },
  }
}

function run(id: number, runNumber: number, prs = [5]) {
  return { id, run_number: runNumber, pull_requests: prs.map((number) => ({ number })) }
}

function review(status: string, conclusion: string | null): Job[] {
  return [
    { name: 'review / push', status: 'completed', conclusion: 'success' },
    { name: 'review / review', status, conclusion },
    { name: 'review / gate', status: 'completed', conclusion: 'success' },
  ]
}

function fakeGet(runs: ReturnType<typeof run>[], jobs: Record<number, Job[]>) {
  const paths: string[] = []
  const get = async (path: string) => {
    paths.push(path)
    if (path === 'repos/o/r/actions/runs/900') return { workflow_id: 77 }
    if (path.startsWith('repos/o/r/actions/workflows/77/runs?')) return { workflow_runs: runs }
    const id = Number(/runs\/(\d+)\/jobs$/.exec(path)?.[1])
    return { jobs: jobs[id] ?? [] }
  }
  return { get, paths }
}

describe('pushReview', () => {
  it('pages past a full page of runs to find an earlier review', async () => {
    const skipped = Array.from({ length: 100 }, (_, i) => run(1000 + i, 9))
    const pages: Record<string, ReturnType<typeof run>[]> = { '1': skipped, '2': [run(1, 2)] }
    const paths: string[] = []
    const get = async (path: string) => {
      paths.push(path)
      if (path === 'repos/o/r/actions/runs/900') return { workflow_id: 77 }
      const page = /[?&]page=(\d+)/.exec(path)?.[1]
      if (page) return { workflow_runs: pages[page] ?? [] }
      return { jobs: path.includes('/runs/1/') ? review('completed', 'success') : review('completed', 'skipped') }
    }
    expect((await pushReview(context(), { get })).message).toContain('runs/1,')
    expect(paths.filter((path) => path.includes('/workflows/77/runs?'))).toHaveLength(2)
  })

  it('runs the review on a push to a PR with no earlier runs', async () => {
    expect(await pushReview(context(), fakeGet([], {}))).toEqual({
      review: true,
      message: 'No review has started for this PR yet, so this push runs one.',
    })
  })

  it('runs the review when every earlier review was skipped, or its run has no review job yet', async () => {
    const deps = fakeGet([run(1, 7), run(2, 8), run(3, 9)], {
      1: review('completed', 'skipped'),
      2: [{ name: 'review / gate', status: 'completed', conclusion: 'failure' }],
      3: review('completed', 'skipped'),
    })
    expect((await pushReview(context(), deps)).review).toBe(true)
  })

  it('ignores later runs and runs for other PRs, so a re-run of a push without a review runs one', async () => {
    const deps = fakeGet([run(1, 8, [6]), run(2, 10), run(3, 11)], {
      1: review('completed', 'success'),
      2: review('completed', 'skipped'),
      3: review('in_progress', null),
    })
    expect((await pushReview(context(), deps)).review).toBe(true)
  })

  it.each([
    ['queued', null],
    ['in_progress', null],
    ['completed', 'success'],
    ['completed', 'failure'],
    ['completed', 'cancelled'],
  ])('skips the review when an earlier one is %s (%s)', async (status, conclusion) => {
    const deps = fakeGet([run(1, 7), run(2, 9)], { 1: review('completed', 'success'), 2: review(status, conclusion) })
    expect(await pushReview(context(), deps)).toEqual({
      review: false,
      message: 'A review already started for this PR, in run https://github.com/o/r/actions/runs/2, so this push skips it.',
    })
  })

  it.each(['queued', 'in_progress'])('skips the review while an earlier run is still deciding (%s)', async (status) => {
    const deps = fakeGet([run(1, 7), run(2, 9)], {
      1: review('completed', 'skipped'),
      2: [
        { name: 'review / push', status, conclusion: null },
        { name: 'review / review', status: 'queued', conclusion: null },
      ],
    })
    expect(await pushReview(context(), deps)).toEqual({
      review: false,
      message: 'An earlier run, https://github.com/o/r/actions/runs/2, is still deciding whether to review this PR, so this push skips it.',
    })
  })

  it('looks past skipped reviews to an earlier one that ran', async () => {
    const deps = fakeGet([run(1, 7), run(2, 9)], { 1: review('completed', 'failure'), 2: review('completed', 'skipped') })
    expect((await pushReview(context(), deps)).message).toContain('runs/1,')
  })

  it.each([
    ['opened', 'pull_request'],
    ['ready_for_review', 'pull_request'],
    ['synchronize', 'pull_request_target'],
  ] as const)('leaves %s on %s to the review job, reading no history', async (action, eventName) => {
    const deps = fakeGet([], {})
    expect((await pushReview(context(action, eventName), deps)).review).toBe(false)
    expect(deps.paths).toEqual([])
  })
})

describe('runPushReview', () => {
  it('writes the decision as a step output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-review-'))
    const eventPath = join(dir, 'event.json')
    const output = join(dir, 'output')
    writeFileSync(eventPath, JSON.stringify({ action: 'synchronize', pull_request: pullRequest }))
    writeFileSync(output, '')
    const { get } = fakeGet([], {})
    vi.mocked(githubGet).mockImplementation(get)
    const out = vi.fn()
    await runPushReview(out, {
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '900',
      GITHUB_RUN_NUMBER: '10',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: output,
    })
    expect(readFileSync(output, 'utf8')).toBe('review=true\n')
    expect(out).toHaveBeenCalledWith('No review has started for this PR yet, so this push runs one.')
  })

  it('names itself when run outside a pull_request workflow', async () => {
    await expect(runPushReview(() => {}, {})).rejects.toThrow(/^yoke review-push runs only/)
  })
})
