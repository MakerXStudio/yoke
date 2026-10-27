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

export function submitReview(pr: PullRequest, body: string, comments: ReviewComment[], exec: Run = run): string {
  const review = {
    commit_id: pr.headRefOid,
    event: 'COMMENT',
    body,
    comments: comments.map((comment) => ({ ...comment, side: 'RIGHT' })),
  }
  const args = ['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${pr.number}/reviews`, '--input', '-', '--jq', '.html_url']
  return exec('gh', args, undefined, JSON.stringify(review)).trim()
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
