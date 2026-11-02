import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { GateContext } from './gate'
import { runUnapproveReview, unapproveReview } from './unapprove'

const fork = { ref: 'feature', sha: 'abcdef123', repo: { full_name: 'fork/r' } }

function context(
  pr: Partial<GateContext['event']['pull_request']> = {},
  action = 'synchronize',
  eventName: GateContext['eventName'] = 'pull_request_target',
): GateContext {
  return {
    repo: 'o/r',
    runId: '900',
    runNumber: 10,
    serverUrl: 'https://github.com',
    eventName,
    event: {
      action,
      pull_request: { number: 5, head: fork, user: { type: 'User' }, labels: [{ name: 'bug' }, { name: 'review' }], ...pr },
    },
  }
}

describe('unapproveReview', () => {
  it('removes the review label from a fork PR after a push', async () => {
    const remove = vi.fn(async () => {})
    expect(await unapproveReview(context(), remove)).toBe(
      'Removed the `review` label from #5 after a push to abcdef1. A maintainer must read the new commits, then add it again to review them.',
    )
    expect(remove).toHaveBeenCalledWith('repos/o/r/issues/5/labels/review')
  })

  it('removes it from a PR whose fork was deleted', async () => {
    const remove = vi.fn(async () => {})
    await unapproveReview(context({ head: { ...fork, repo: null } }), remove)
    expect(remove).toHaveBeenCalledOnce()
  })

  it.each([
    ['a pull_request push', context({}, 'synchronize', 'pull_request'), 'Only a push to a fork PR'],
    ['another action', context({}, 'labeled'), 'Only a push to a fork PR'],
    ['a PR from the repo itself', context({ head: { ...fork, repo: { full_name: 'o/r' } } }), 'is not from a fork'],
    ['a fork PR without the label', context({ labels: [{ name: 'bug' }] }), 'has no `review` label'],
    ['an event without labels', context({ labels: undefined }), 'has no `review` label'],
  ])('leaves labels alone for %s', async (_, ctx, message) => {
    const remove = vi.fn(async () => {})
    expect(await unapproveReview(ctx, remove)).toContain(message)
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('runUnapproveReview', () => {
  it('names itself when run outside GitHub Actions', async () => {
    await expect(runUnapproveReview(() => {}, {})).rejects.toThrow('yoke review-unapprove runs only in a GitHub Actions')
  })

  it('reports what it did on a push to a PR from the repo itself', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'unapprove-')), 'event.json')
    writeFileSync(path, JSON.stringify(context({ head: { ...fork, repo: { full_name: 'o/r' } } }).event))
    const out = vi.fn()
    const env = {
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '900',
      GITHUB_RUN_NUMBER: '10',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_EVENT_NAME: 'pull_request_target',
      GITHUB_EVENT_PATH: path,
    }
    await runUnapproveReview(out, env)
    expect(out).toHaveBeenCalledWith('#5 is not from a fork, so it has no approval to remove.')
  })
})
