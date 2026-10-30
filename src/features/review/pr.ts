import { execFile } from 'node:child_process'
import { join } from 'node:path'

import type { PriorComment } from './comments'
import type { PullRequest } from './request'

export type Run = (command: string, args: string[], cwd?: string, input?: string) => Promise<string>

export class ReviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewError'
  }
}

const maxBuffer = 256 * 1024 * 1024

const run: Run = (command, args, cwd, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, encoding: 'utf8', maxBuffer }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      const detail = stderr.trim()
      reject(new ReviewError(`\`${command} ${args.join(' ')}\` failed${detail ? `: ${detail}` : ''}`))
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })

const fields = 'number,url,title,baseRefName,baseRefOid,headRefName,headRefOid,files'

function isPullRequest(value: unknown): value is PullRequest {
  return typeof value === 'object' && value !== null && 'number' in value && 'url' in value && 'headRefOid' in value && 'files' in value
}

export async function fetchPr(number: string | undefined, exec: Run = run): Promise<PullRequest> {
  if (number !== undefined && !/^\d+$/.test(number)) throw new ReviewError(`PR number must be a positive integer, got "${number}"`)
  const args = ['pr', 'view', ...(number ? [number] : []), '--json', fields]
  const pr: unknown = JSON.parse(await exec('gh', args))
  if (!isPullRequest(pr)) throw new ReviewError('`gh pr view` returned an unexpected response')
  return pr
}

export async function fetchDiff(pr: PullRequest, exec: Run = run): Promise<string> {
  const diff = await exec('gh', ['pr', 'diff', String(pr.number)])
  const current = await fetchPr(String(pr.number), exec)
  if (current.headRefOid !== pr.headRefOid || current.baseRefOid !== pr.baseRefOid)
    throw new ReviewError(`#${pr.number} changed while its diff was being fetched; run the review again`)
  return diff
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

export async function fetchPriorComments(pr: PullRequest, exec: Run = run): Promise<PriorComment[]> {
  const pulls = `repos/{owner}/{repo}/pulls/${pr.number}`
  const [comments, reviews] = await Promise.all([
    exec('gh', ['api', '--paginate', `${pulls}/comments`, '--jq', `.[] | ${commentFields}`]),
    exec('gh', ['api', '--paginate', `${pulls}/reviews`, '--jq', `.[] | select(.body != "") | ${reviewFields}`]),
  ])
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

export async function openPendingReview(pr: PullRequest, exec: Run = run): Promise<PendingReview> {
  const args = ['api', '--method', 'POST', reviewsPath(pr), '--input', '-', '--jq', '{id, node_id}']
  const review: unknown = JSON.parse(await exec('gh', args, undefined, JSON.stringify({ commit_id: pr.headRefOid })))
  if (!isPendingReview(review)) throw new ReviewError('Opening a pending review returned an unexpected response')
  return { id: review.id, nodeId: review.node_id }
}

const addThread = `mutation($review: ID!, $path: String!, $line: Int!, $body: String!) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $review, path: $path, line: $line, side: RIGHT, body: $body}) { thread { id } }
}`

export async function addReviewComment(review: PendingReview, { path, line, body }: ReviewComment, exec: Run = run): Promise<void> {
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
  await exec('gh', ['api', 'graphql', ...variables])
}

export async function submitPendingReview(pr: PullRequest, review: PendingReview, body: string, exec: Run = run): Promise<string> {
  const args = ['api', '--method', 'POST', `${reviewsPath(pr)}/${review.id}/events`, '--input', '-', '--jq', '.html_url']
  return (await exec('gh', args, undefined, JSON.stringify({ event: 'COMMENT', body }))).trim()
}

export async function discardPendingReview(pr: PullRequest, review: PendingReview, exec: Run = run): Promise<void> {
  await exec('gh', ['api', '--method', 'DELETE', `${reviewsPath(pr)}/${review.id}`])
}

export type ReviewApi = {
  open: (pr: PullRequest) => Promise<PendingReview>
  add: (review: PendingReview, comment: ReviewComment) => Promise<void>
  submit: (pr: PullRequest, review: PendingReview, body: string) => Promise<string>
  discard: (pr: PullRequest, review: PendingReview) => Promise<void>
}

export const github: ReviewApi = {
  open: (pr) => openPendingReview(pr),
  add: (review, comment) => addReviewComment(review, comment),
  submit: (pr, review, body) => submitPendingReview(pr, review, body),
  discard: (pr, review) => discardPendingReview(pr, review),
}

export type Checkout = { cwd: string; remove: () => Promise<void> }

function repoSlug(remoteUrl: string): string {
  return remoteUrl
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .slice(-2)
    .join('/')
    .toLowerCase()
}

async function prRemote(pr: PullRequest, root: string, exec: Run): Promise<string> {
  const url = new URL(pr.url)
  const [, owner = '', repo = ''] = url.pathname.split('/')
  const slug = `${owner}/${repo}`.toLowerCase()
  const remotes = (await exec('git', ['remote', '-v'], root)).split('\n').map((line) => line.split(/\s+/))
  return remotes.find(([, remoteUrl]) => remoteUrl && repoSlug(remoteUrl) === slug)?.[0] ?? `${url.origin}/${owner}/${repo}.git`
}

export async function checkoutHead(pr: PullRequest, reviewDir: string, exec: Run = run): Promise<Checkout> {
  const root = (await exec('git', ['rev-parse', '--show-toplevel'])).trim()
  const atHead = (await exec('git', ['rev-parse', 'HEAD'], root)).trim() === pr.headRefOid
  if (atHead && !(await exec('git', ['status', '--porcelain'], root)).trim()) return { cwd: root, remove: async () => {} }
  const tree = join(reviewDir, 'head')
  await exec('git', ['fetch', '--quiet', await prRemote(pr, root, exec), `pull/${pr.number}/head`], root)
  await exec('git', ['worktree', 'add', '--quiet', '--detach', tree, pr.headRefOid], root)
  return {
    cwd: tree,
    remove: async () => {
      await exec('git', ['worktree', 'remove', '--force', tree], root)
    },
  }
}
