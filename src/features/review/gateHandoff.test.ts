import { describe, expect, it, vi } from 'vitest'

import type { GateContext, GateDeps } from './gate'
import { handOffApprovedReview, runPollInterval } from './gateHandoff'

const pullRequest = { number: 5, head: { ref: 'feature', sha: 'abcdef123', repo: { full_name: 'fork/r' } }, user: { type: 'User' } }

function context(action = 'labeled', label = 'review'): GateContext {
  return {
    repo: 'o/r',
    runId: '900',
    runNumber: 10,
    serverUrl: 'https://github.com',
    eventName: 'pull_request_target',
    event: { action, label: { name: label }, pull_request: pullRequest },
  }
}

type Run = { id: number; run_number: number; status: string }

function fakeDeps(
  runs: Run[],
  statuses: string[] = [],
  jobs = [
    { id: 70, name: 'review / review' },
    { id: 71, name: 'review / gate' },
  ],
) {
  const paths: string[] = []
  const get = async (path: string) => {
    paths.push(path)
    if (path === 'repos/o/r/actions/runs/900') return { workflow_id: 77 }
    if (path === 'repos/o/r/actions/workflows/77/runs?event=pull_request&head_sha=abcdef123&per_page=100') return { workflow_runs: runs }
    if (/runs\/\d+\/jobs$/.test(path)) return { jobs }
    const id = Number(/runs\/(\d+)$/.exec(path)?.[1])
    return { id, run_number: 1, status: statuses.shift() ?? 'completed' }
  }
  const post = vi.fn<GateDeps['post']>(async () => null)
  return { paths, get, post, sleep: vi.fn(async () => {}), log: () => {} }
}

describe('handOffApprovedReview', () => {
  it.each([
    ['another action', context('synchronize'), 'success'],
    ['another label', context('labeled', 'bug'), 'success'],
    ['a skipped review', context(), 'skipped'],
  ])('does nothing for %s', async (_, ctx, result) => {
    const deps = fakeDeps([])
    expect((await handOffApprovedReview(result, ctx, deps)).pass).toBe(true)
    expect(deps.post).not.toHaveBeenCalled()
  })

  it.each([
    ['success', 'success'],
    ['failure', 'failure'],
    ['cancelled', 'failure'],
  ])('records a %s review on the PR head and re-runs its latest gate', async (result, state) => {
    const deps = fakeDeps([
      { id: 1, run_number: 3, status: 'completed' },
      { id: 2, run_number: 4, status: 'completed' },
    ])
    const verdict = await handOffApprovedReview(result, context(), deps)
    expect(verdict).toEqual({
      pass: result === 'success',
      message: `The review a maintainer approved finished with ${result}. Re-ran the gate for abcdef1 in https://github.com/o/r/actions/runs/2.`,
    })
    expect(deps.post.mock.calls).toEqual([
      [
        'repos/o/r/statuses/abcdef123',
        {
          state,
          context: 'review / approved review',
          description: `finished with ${result}`,
          target_url: 'https://github.com/o/r/actions/runs/900',
        },
      ],
      ['repos/o/r/actions/jobs/71/rerun', {}],
    ])
  })

  it('marks the approved review as running on the PR head and re-runs its gate when it starts', async () => {
    const deps = fakeDeps([{ id: 2, run_number: 4, status: 'completed' }])
    expect(await handOffApprovedReview('pending', context(), deps)).toEqual({
      pass: true,
      message: 'Marked the review a maintainer approved as running. Re-ran the gate for abcdef1 in https://github.com/o/r/actions/runs/2.',
    })
    expect(deps.post.mock.calls).toEqual([
      [
        'repos/o/r/statuses/abcdef123',
        {
          state: 'pending',
          context: 'review / approved review',
          description: 'is running',
          target_url: 'https://github.com/o/r/actions/runs/900',
        },
      ],
      ['repos/o/r/actions/jobs/71/rerun', {}],
    ])
  })

  it('waits for the pull_request run to finish before re-running its gate', async () => {
    const deps = fakeDeps([{ id: 2, run_number: 4, status: 'in_progress' }], ['in_progress', 'completed'])
    await handOffApprovedReview('success', context(), deps)
    expect(deps.sleep).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenCalledWith(runPollInterval)
    expect(deps.post).toHaveBeenLastCalledWith('repos/o/r/actions/jobs/71/rerun', {})
  })

  it('only records the review when no pull_request run exists for the head', async () => {
    const deps = fakeDeps([])
    expect((await handOffApprovedReview('success', context(), deps)).message).toContain(
      'No pull_request run of this workflow exists for abcdef1; its gate reads this result when it runs.',
    )
    expect(deps.post).toHaveBeenCalledTimes(1)
  })

  it('only records the review when the run has no gate job yet', async () => {
    const deps = fakeDeps([{ id: 2, run_number: 4, status: 'completed' }], [], [])
    expect((await handOffApprovedReview('success', context(), deps)).message).toContain('has no gate job to re-run')
    expect(deps.post).toHaveBeenCalledTimes(1)
  })
})
