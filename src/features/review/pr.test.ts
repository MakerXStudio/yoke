import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  addReviewComment,
  checkoutHead,
  discardPendingReview,
  fetchDiff,
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
  url: 'https://github.com/o/r/pull/9',
  title: 't',
  baseRefName: 'main',
  baseRefOid: 'base',
  headRefName: 'feature',
  headRefOid: 'head',
  files: [],
}

function returning(output: string) {
  return vi.fn<Run>(async () => output)
}

const forkRemotes = [
  'origin\tgit@github.com:me/r.git (fetch)',
  'origin\tgit@github.com:me/r.git (push)',
  'upstream\thttps://github.com/O/R.git (fetch)',
  'upstream\thttps://github.com/O/R.git (push)',
].join('\n')

function fakeGit(head: string, status = '', remotes = forkRemotes) {
  return vi.fn<Run>(async (_, args) => {
    if (args.includes('--show-toplevel')) return '/repo\n'
    if (args[0] === 'rev-parse') return `${head}\n`
    if (args[0] === 'status') return status
    if (args[0] === 'remote') return remotes
    return ''
  })
}

describe('fetchPr', () => {
  it("views the current branch's PR when no number is given", async () => {
    const exec = returning(JSON.stringify(pr))
    expect(await fetchPr(undefined, exec)).toEqual(pr)
    expect(exec.mock.calls[0]?.[1].slice(0, 3)).toEqual(['pr', 'view', '--json'])
  })

  it('views the given PR', async () => {
    const exec = returning(JSON.stringify(pr))
    await fetchPr('9', exec)
    expect(exec.mock.calls[0]?.[1].slice(0, 3)).toEqual(['pr', 'view', '9'])
  })

  it('rejects a PR number that is not a positive integer', async () => {
    const exec = vi.fn<Run>()
    await expect(fetchPr('--web', exec)).rejects.toThrow(ReviewError)
    expect(exec).not.toHaveBeenCalled()
  })
})

function fakeGh(current: PullRequest) {
  return vi.fn<Run>(async (_, args) => (args[1] === 'diff' ? 'the diff' : JSON.stringify(current)))
}

describe('fetchDiff', () => {
  it('returns the diff when the PR revisions are unchanged', async () => {
    expect(await fetchDiff(pr, fakeGh(pr))).toBe('the diff')
  })

  it('rejects when the PR head moved while the diff was fetched', async () => {
    await expect(fetchDiff(pr, fakeGh({ ...pr, headRefOid: 'newer' }))).rejects.toThrow(ReviewError)
  })

  it('rejects when the PR base moved while the diff was fetched', async () => {
    await expect(fetchDiff(pr, fakeGh({ ...pr, baseRefOid: 'newer' }))).rejects.toThrow(ReviewError)
  })
})

describe('checkoutHead', () => {
  it('reviews in the repo when it is already at the PR head', async () => {
    const exec = fakeGit('head')
    expect((await checkoutHead(pr, '/tmp/r', exec)).cwd).toBe('/repo')
    expect(exec.mock.calls.map((c) => c[1][0])).toEqual(['rev-parse', 'rev-parse', 'status'])
  })

  it('uses a worktree when the repo is at the PR head but has local edits', async () => {
    const exec = fakeGit('head', ' M src/a.ts\n')
    expect((await checkoutHead(pr, '/tmp/r', exec)).cwd).toBe(join('/tmp/r', 'head'))
  })

  it('checks the PR head out into a detached worktree otherwise, and removes it after', async () => {
    const exec = fakeGit('other')
    const tree = join('/tmp/r', 'head')
    const checkout = await checkoutHead(pr, '/tmp/r', exec)
    expect(checkout.cwd).toBe(tree)
    expect(exec).toHaveBeenCalledWith('git', ['worktree', 'add', '--quiet', '--detach', tree, 'head'], '/repo')
    await checkout.remove()
    expect(exec).toHaveBeenLastCalledWith('git', ['worktree', 'remove', '--force', tree], '/repo')
  })

  it("fetches the PR head from the remote that serves the PR's repo", async () => {
    const exec = fakeGit('other')
    await checkoutHead(pr, '/tmp/r', exec)
    expect(exec).toHaveBeenCalledWith('git', ['fetch', '--quiet', 'upstream', 'pull/9/head'], '/repo')
  })

  it("fetches from the PR's repo URL when no remote serves it", async () => {
    const exec = fakeGit('other', '', 'origin\tgit@github.com:me/r.git (fetch)')
    await checkoutHead(pr, '/tmp/r', exec)
    expect(exec).toHaveBeenCalledWith('git', ['fetch', '--quiet', 'https://github.com/o/r.git', 'pull/9/head'], '/repo')
  })
})

describe('fetchPriorComments', () => {
  it('reads inline comments and non-empty review bodies from the GitHub API', async () => {
    const exec = vi.fn<Run>(async (_, args) =>
      args[2]?.endsWith('/comments')
        ? '{"path":"a.ts","line":3,"author":"wade","body":"x"}\n'
        : '{"path":null,"line":null,"author":"rob","body":"y"}\n\n',
    )
    expect(await fetchPriorComments(pr, exec)).toEqual([
      { path: 'a.ts', line: 3, author: 'wade', body: 'x' },
      { path: null, line: null, author: 'rob', body: 'y' },
    ])
    expect(exec.mock.calls.map((c) => c[1][2])).toEqual(['repos/{owner}/{repo}/pulls/9/comments', 'repos/{owner}/{repo}/pulls/9/reviews'])
  })
})

describe('pending review', () => {
  const review = { id: 5, nodeId: 'PRR_5' }

  it('opens a pending review at the PR head', async () => {
    const exec = returning('{"id":5,"node_id":"PRR_5"}')
    expect(await openPendingReview(pr, exec)).toEqual(review)
    const [command, args, , input] = exec.mock.calls[0] ?? []
    expect([command, ...(args ?? []).slice(0, 4)]).toEqual(['gh', 'api', '--method', 'POST', 'repos/{owner}/{repo}/pulls/9/reviews'])
    expect(JSON.parse(input ?? '')).toEqual({ commit_id: 'head' })
  })

  it('adds a right-side comment to it by node id', async () => {
    const exec = returning('')
    await addReviewComment(review, { path: 'a.ts', line: 3, body: '@not-a-file' }, exec)
    const args = exec.mock.calls[0]?.[1] ?? []
    expect(args.slice(0, 2)).toEqual(['api', 'graphql'])
    expect(args).toEqual(expect.arrayContaining(['review=PRR_5', 'path=a.ts', 'line=3', 'body=@not-a-file']))
    expect(args[args.indexOf('body=@not-a-file') - 1]).toBe('-f')
    expect(args.find((arg) => arg.startsWith('query='))).toContain('side: RIGHT')
  })

  it('submits it as a COMMENT with the body', async () => {
    const exec = returning('https://github.com/o/r/pull/9#pullrequestreview-5\n')
    expect(await submitPendingReview(pr, review, 'body', exec)).toBe('https://github.com/o/r/pull/9#pullrequestreview-5')
    const [, args, , input] = exec.mock.calls[0] ?? []
    expect(args).toContain('repos/{owner}/{repo}/pulls/9/reviews/5/events')
    expect(JSON.parse(input ?? '')).toEqual({ event: 'COMMENT', body: 'body' })
  })

  it('deletes it', async () => {
    const exec = returning('')
    await discardPendingReview(pr, review, exec)
    expect(exec).toHaveBeenCalledWith('gh', ['api', '--method', 'DELETE', 'repos/{owner}/{repo}/pulls/9/reviews/5'])
  })
})
