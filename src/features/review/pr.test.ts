import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  addReviewComment,
  checkoutHead,
  discardPendingReview,
  fetchPr,
  fetchPriorComments,
  openPendingReview,
  ReviewError,
  type Run,
  submitPendingReview,
} from './pr'
import type { PullRequest } from './request'

const pr: PullRequest = {
  number: 9,
  title: 't',
  baseRefName: 'main',
  baseRefOid: 'base',
  headRefName: 'feature',
  headRefOid: 'head',
  files: [],
}

function fakeGit(head: string) {
  return vi.fn<Run>((_, args) => {
    if (args.includes('--show-toplevel')) return '/repo\n'
    if (args[0] === 'rev-parse') return `${head}\n`
    return ''
  })
}

describe('fetchPr', () => {
  it("views the current branch's PR when no number is given", () => {
    const exec = vi.fn<Run>(() => JSON.stringify(pr))
    expect(fetchPr(undefined, exec)).toEqual(pr)
    expect(exec.mock.calls[0]?.[1].slice(0, 3)).toEqual(['pr', 'view', '--json'])
  })

  it('views the given PR', () => {
    const exec = vi.fn<Run>(() => JSON.stringify(pr))
    fetchPr('9', exec)
    expect(exec.mock.calls[0]?.[1].slice(0, 3)).toEqual(['pr', 'view', '9'])
  })

  it('rejects a PR number that is not a positive integer', () => {
    const exec = vi.fn<Run>()
    expect(() => fetchPr('--web', exec)).toThrow(ReviewError)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('checkoutHead', () => {
  it('reviews in the repo when it is already at the PR head', () => {
    const exec = fakeGit('head')
    expect(checkoutHead(pr, '/tmp/r', exec).cwd).toBe('/repo')
    expect(exec.mock.calls.map((c) => c[1][0])).toEqual(['rev-parse', 'rev-parse'])
  })

  it('checks the PR head out into a detached worktree otherwise, and removes it after', () => {
    const exec = fakeGit('other')
    const tree = join('/tmp/r', 'head')
    const checkout = checkoutHead(pr, '/tmp/r', exec)
    expect(checkout.cwd).toBe(tree)
    expect(exec).toHaveBeenCalledWith('git', ['fetch', '--quiet', 'origin', 'pull/9/head'], '/repo')
    expect(exec).toHaveBeenCalledWith('git', ['worktree', 'add', '--quiet', '--detach', tree, 'head'], '/repo')
    checkout.remove()
    expect(exec).toHaveBeenLastCalledWith('git', ['worktree', 'remove', '--force', tree], '/repo')
  })
})

describe('fetchPriorComments', () => {
  it('reads inline comments and non-empty review bodies from the GitHub API', () => {
    const exec = vi.fn<Run>((_, args) =>
      args[2]?.endsWith('/comments')
        ? '{"path":"a.ts","line":3,"author":"wade","body":"x"}\n'
        : '{"path":null,"line":null,"author":"rob","body":"y"}\n\n',
    )
    expect(fetchPriorComments(pr, exec)).toEqual([
      { path: 'a.ts', line: 3, author: 'wade', body: 'x' },
      { path: null, line: null, author: 'rob', body: 'y' },
    ])
    expect(exec.mock.calls.map((c) => c[1][2])).toEqual(['repos/{owner}/{repo}/pulls/9/comments', 'repos/{owner}/{repo}/pulls/9/reviews'])
  })
})

describe('pending review', () => {
  const review = { id: 5, nodeId: 'PRR_5' }

  it('opens a pending review at the PR head', () => {
    const exec = vi.fn<Run>(() => '{"id":5,"node_id":"PRR_5"}')
    expect(openPendingReview(pr, exec)).toEqual(review)
    const [command, args, , input] = exec.mock.calls[0] ?? []
    expect([command, ...(args ?? []).slice(0, 4)]).toEqual(['gh', 'api', '--method', 'POST', 'repos/{owner}/{repo}/pulls/9/reviews'])
    expect(JSON.parse(input ?? '')).toEqual({ commit_id: 'head' })
  })

  it('adds a right-side comment to it by node id', () => {
    const exec = vi.fn<Run>(() => '')
    addReviewComment(review, { path: 'a.ts', line: 3, body: '@not-a-file' }, exec)
    const args = exec.mock.calls[0]?.[1] ?? []
    expect(args.slice(0, 2)).toEqual(['api', 'graphql'])
    expect(args).toEqual(expect.arrayContaining(['review=PRR_5', 'path=a.ts', 'line=3', 'body=@not-a-file']))
    expect(args[args.indexOf('body=@not-a-file') - 1]).toBe('-f')
    expect(args.find((arg) => arg.startsWith('query='))).toContain('side: RIGHT')
  })

  it('submits it as a COMMENT with the body', () => {
    const exec = vi.fn<Run>(() => 'https://github.com/o/r/pull/9#pullrequestreview-5\n')
    expect(submitPendingReview(pr, review, 'body', exec)).toBe('https://github.com/o/r/pull/9#pullrequestreview-5')
    const [, args, , input] = exec.mock.calls[0] ?? []
    expect(args).toContain('repos/{owner}/{repo}/pulls/9/reviews/5/events')
    expect(JSON.parse(input ?? '')).toEqual({ event: 'COMMENT', body: 'body' })
  })

  it('deletes it', () => {
    const exec = vi.fn<Run>(() => '')
    discardPendingReview(pr, review, exec)
    expect(exec).toHaveBeenCalledWith('gh', ['api', '--method', 'DELETE', 'repos/{owner}/{repo}/pulls/9/reviews/5'])
  })
})
