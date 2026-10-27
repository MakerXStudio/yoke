import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import type { PriorComment } from './comments'
import type { PullRequest } from './request'

export type Run = (command: string, args: string[], cwd?: string, input?: string) => string

export class ReviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewError'
  }
}

const maxBuffer = 256 * 1024 * 1024

const run: Run = (command, args, cwd, input) => {
  try {
    return execFileSync(command, args, {
      cwd,
      input,
      encoding: 'utf8',
      maxBuffer,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : ''
    throw new ReviewError(`\`${command} ${args.join(' ')}\` failed${stderr ? `: ${stderr}` : ''}`)
  }
}

const fields = 'number,title,baseRefName,baseRefOid,headRefName,headRefOid,files'

function isPullRequest(value: unknown): value is PullRequest {
  return typeof value === 'object' && value !== null && 'number' in value && 'headRefOid' in value && 'files' in value
}

export function fetchPr(number: string | undefined, exec: Run = run): PullRequest {
  if (number !== undefined && !/^\d+$/.test(number)) throw new ReviewError(`PR number must be a positive integer, got "${number}"`)
  const args = ['pr', 'view', ...(number ? [number] : []), '--json', fields]
  const pr: unknown = JSON.parse(exec('gh', args))
  if (!isPullRequest(pr)) throw new ReviewError('`gh pr view` returned an unexpected response')
  return pr
}

export function fetchDiff(pr: PullRequest, exec: Run = run): string {
  return exec('gh', ['pr', 'diff', String(pr.number)])
}

const commentFields = '{path, line: (.line // .original_line), author: (.user.login // "ghost"), body}'
const reviewFields = '{path: null, line: null, author: (.user.login // "ghost"), body}'

function isPriorComment(value: unknown): value is PriorComment {
  return typeof value === 'object' && value !== null && 'body' in value && typeof value.body === 'string' && 'author' in value
}

function jsonLines(output: string): PriorComment[] {
  return output
    .split('\n')
    .filter((line) => line.trim())
    .map((line): unknown => JSON.parse(line))
    .filter(isPriorComment)
}

export function fetchPriorComments(pr: PullRequest, exec: Run = run): PriorComment[] {
  const pulls = `repos/{owner}/{repo}/pulls/${pr.number}`
  const comments = exec('gh', ['api', '--paginate', `${pulls}/comments`, '--jq', `.[] | ${commentFields}`])
  const reviews = exec('gh', ['api', '--paginate', `${pulls}/reviews`, '--jq', `.[] | select(.body != "") | ${reviewFields}`])
  return [...jsonLines(comments), ...jsonLines(reviews)]
}

export type ReviewComment = { path: string; line: number; body: string }

export type PendingReview = { id: number; nodeId: string }

function reviewsPath(pr: PullRequest): string {
  return `repos/{owner}/{repo}/pulls/${pr.number}/reviews`
}

function isPendingReview(value: unknown): value is { id: number; node_id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'node_id' in value &&
    typeof value.node_id === 'string'
  )
}

export function openPendingReview(pr: PullRequest, exec: Run = run): PendingReview {
  const args = ['api', '--method', 'POST', reviewsPath(pr), '--input', '-', '--jq', '{id, node_id}']
  const review: unknown = JSON.parse(exec('gh', args, undefined, JSON.stringify({ commit_id: pr.headRefOid })))
  if (!isPendingReview(review)) throw new ReviewError('Opening a pending review returned an unexpected response')
  return { id: review.id, nodeId: review.node_id }
}

const addThread = `mutation($review: ID!, $path: String!, $line: Int!, $body: String!) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $review, path: $path, line: $line, side: RIGHT, body: $body}) { thread { id } }
}`

export function addReviewComment(review: PendingReview, { path, line, body }: ReviewComment, exec: Run = run): void {
  const variables = [
    '-f',
    `query=${addThread}`,
    '-f',
    `review=${review.nodeId}`,
    '-f',
    `path=${path}`,
    '-F',
    `line=${line}`,
    '-f',
    `body=${body}`,
  ]
  exec('gh', ['api', 'graphql', ...variables])
}

export function submitPendingReview(pr: PullRequest, review: PendingReview, body: string, exec: Run = run): string {
  const args = ['api', '--method', 'POST', `${reviewsPath(pr)}/${review.id}/events`, '--input', '-', '--jq', '.html_url']
  return exec('gh', args, undefined, JSON.stringify({ event: 'COMMENT', body })).trim()
}

export function discardPendingReview(pr: PullRequest, review: PendingReview, exec: Run = run): void {
  exec('gh', ['api', '--method', 'DELETE', `${reviewsPath(pr)}/${review.id}`])
}

export type ReviewApi = {
  open: (pr: PullRequest) => PendingReview
  add: (review: PendingReview, comment: ReviewComment) => void
  submit: (pr: PullRequest, review: PendingReview, body: string) => string
  discard: (pr: PullRequest, review: PendingReview) => void
}

export const github: ReviewApi = {
  open: (pr) => openPendingReview(pr),
  add: (review, comment) => addReviewComment(review, comment),
  submit: (pr, review, body) => submitPendingReview(pr, review, body),
  discard: (pr, review) => discardPendingReview(pr, review),
}

export type Checkout = { cwd: string; remove: () => void }

export function checkoutHead(pr: PullRequest, reviewDir: string, exec: Run = run): Checkout {
  const root = exec('git', ['rev-parse', '--show-toplevel']).trim()
  if (exec('git', ['rev-parse', 'HEAD'], root).trim() === pr.headRefOid) return { cwd: root, remove: () => {} }
  const tree = join(reviewDir, 'head')
  exec('git', ['fetch', '--quiet', 'origin', `pull/${pr.number}/head`], root)
  exec('git', ['worktree', 'add', '--quiet', '--detach', tree, pr.headRefOid], root)
  return { cwd: tree, remove: () => exec('git', ['worktree', 'remove', '--force', tree], root) }
}
