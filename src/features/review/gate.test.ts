import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { type GateContext, gateContext, type GateDeps, pollInterval, reviewGate } from './gate'
import { ReviewError } from './pr'

type Job = { name: string; status: string; conclusion: string | null }

const pullRequest = { number: 5, head: { ref: 'feature', repo: { full_name: 'o/r' } }, user: { type: 'User' } }

function context(action = 'synchronize', pr: Partial<GateContext['event']['pull_request']> = {}): GateContext {
  return {
    repo: 'o/r',
    runId: '900',
    runNumber: 10,
    serverUrl: 'https://github.com',
    event: { action, pull_request: { ...pullRequest, ...pr } },
  }
}

function run(id: number, runNumber: number, prs = [5]) {
  return { id, run_number: runNumber, pull_requests: prs.map((number) => ({ number })) }
}

function review(status: string, conclusion: string | null): Job[] {
  return [
    { name: 'review / review', status, conclusion },
    { name: 'review / gate', status: 'completed', conclusion: 'success' },
  ]
}

function fakeDeps(runs: ReturnType<typeof run>[], jobs: Record<number, Job[][]>): GateDeps & { paths: string[] } {
  const paths: string[] = []
  const get = async (path: string) => {
    paths.push(path)
    if (path === 'repos/o/r/actions/runs/900') return { workflow_id: 77 }
    if (path.startsWith('repos/o/r/actions/workflows/77/runs?')) return { workflow_runs: runs }
    const id = Number(/runs\/(\d+)\/jobs$/.exec(path)?.[1])
    return { jobs: jobs[id]?.shift() ?? [] }
  }
  return { paths, get, sleep: vi.fn(async () => {}), log: () => {} }
}

describe('reviewGate', () => {
  it.each(['success', 'failure', 'cancelled'])('mirrors a review that ran on this event (%s)', async (result) => {
    const deps = fakeDeps([], {})
    const verdict = await reviewGate(result, context('opened'), deps)
    expect(verdict.pass).toBe(result === 'success')
    expect(verdict.message).toContain(`finished with ${result}`)
    expect(deps.paths).toEqual([])
  })

  it('tells how to re-run a failed review', async () => {
    expect((await reviewGate('failure', context('opened'), fakeDeps([], {}))).message).toMatch(
      /Mark the PR as draft, then ready for review/,
    )
  })

  it.each([
    ['a fork', { head: { ref: 'feature', repo: { full_name: 'fork/r' } } }],
    ['a deleted fork', { head: { ref: 'feature', repo: null } }],
    ['a bot', { user: { type: 'Bot' } }],
  ])('passes a PR from %s without reading history', async (_, pr) => {
    const deps = fakeDeps([run(1, 9)], { 1: [review('completed', 'failure')] })
    expect((await reviewGate('skipped', context('synchronize', pr), deps)).pass).toBe(true)
    expect(deps.paths).toEqual([])
  })

  it('blocks a draft PR until it is ready for review', async () => {
    const verdict = await reviewGate('skipped', context('opened'), fakeDeps([], {}))
    expect(verdict.pass).toBe(false)
    expect(verdict.message).toMatch(/^No review has completed for this PR yet\. Mark the PR as ready for review/)
  })

  it('fails a push while the latest review that ran failed', async () => {
    const deps = fakeDeps([run(1, 7), run(2, 8)], { 1: [review('completed', 'success')], 2: [review('completed', 'failure')] })
    const verdict = await reviewGate('skipped', context(), deps)
    expect(verdict.pass).toBe(false)
    expect(verdict.message).toContain('https://github.com/o/r/actions/runs/2, finished with failure')
  })

  it('passes a push when the latest review that ran succeeded, whatever it found', async () => {
    const deps = fakeDeps([run(1, 7), run(2, 8)], { 1: [review('completed', 'failure')], 2: [review('completed', 'success')] })
    expect((await reviewGate('skipped', context(), deps)).pass).toBe(true)
  })

  it('looks past runs whose review was skipped', async () => {
    const deps = fakeDeps([run(1, 7), run(2, 8), run(3, 9)], {
      1: [review('completed', 'failure')],
      2: [review('completed', 'skipped')],
      3: [[{ name: 'review / gate', status: 'completed', conclusion: 'success' }]],
    })
    const verdict = await reviewGate('skipped', context(), deps)
    expect(verdict.pass).toBe(false)
    expect(verdict.message).toContain('runs/1,')
  })

  it('ignores later runs, runs for other PRs, and filters by branch', async () => {
    const deps = fakeDeps([run(1, 7), run(2, 8, [6]), run(3, 11)], {
      1: [review('completed', 'success')],
      2: [review('completed', 'failure')],
      3: [review('completed', 'failure')],
    })
    expect((await reviewGate('skipped', context(), deps)).pass).toBe(true)
    expect(deps.paths[1]).toBe('repos/o/r/actions/workflows/77/runs?event=pull_request&branch=feature&per_page=100')
  })

  it('waits for a review still running', async () => {
    const deps = fakeDeps([run(1, 9)], { 1: [review('in_progress', null), review('queued', null), review('completed', 'failure')] })
    expect((await reviewGate('skipped', context(), deps)).pass).toBe(false)
    expect(deps.sleep).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenCalledWith(pollInterval)
  })

  it('blocks a push when no earlier review completed', async () => {
    const deps = fakeDeps([run(1, 9)], { 1: [review('completed', 'skipped')] })
    expect((await reviewGate('skipped', context(), deps)).pass).toBe(false)
  })
})

function eventFile(event: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'gate-')), 'event.json')
  writeFileSync(path, JSON.stringify(event))
  return path
}

describe('gateContext', () => {
  const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '900', GITHUB_RUN_NUMBER: '10', GITHUB_SERVER_URL: 'https://github.com' }

  it('reads the run and the pull_request event', () => {
    const event = { action: 'synchronize', pull_request: pullRequest }
    expect(gateContext({ ...env, GITHUB_EVENT_PATH: eventFile(event) })).toEqual(context())
  })

  it('rejects other events', () => {
    expect(() => gateContext({ ...env, GITHUB_EVENT_PATH: eventFile({ ref: 'refs/heads/main' }) })).toThrow(ReviewError)
  })

  it('rejects running outside GitHub Actions', () => {
    expect(() => gateContext({})).toThrow(/only in a GitHub Actions/)
  })
})
