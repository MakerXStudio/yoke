import { type GateContext, gateContext } from './gate'
import { reviewLabel } from './gateHandoff'
import { githubDelete } from './pr'

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.includes('(HTTP 404)')
}

export async function unapproveReview({ repo, eventName, event }: GateContext, remove: (path: string) => Promise<void>): Promise<string> {
  const { number, head, labels } = event.pull_request
  if (eventName !== 'pull_request_target' || event.action !== 'synchronize')
    return 'Only a push to a fork PR, on pull_request_target, removes its approval.'
  if (head.repo?.full_name === repo) return `#${number} is not from a fork, so it has no approval to remove.`
  if (!labels?.some((label) => label.name === reviewLabel)) return `#${number} has no \`${reviewLabel}\` label to remove.`
  try {
    await remove(`repos/${repo}/issues/${number}/labels/${reviewLabel}`)
  } catch (error) {
    if (!isNotFound(error)) throw error
    return `#${number} no longer has the \`${reviewLabel}\` label; it was already removed.`
  }
  return `Removed the \`${reviewLabel}\` label from #${number} after a push to ${head.sha.slice(0, 7)}. A maintainer must read the new commits, then add it again to review them.`
}

export async function runUnapproveReview(out: (message: string) => void, env = process.env): Promise<void> {
  out(await unapproveReview(gateContext(env, 'yoke review unapprove'), (path) => githubDelete(path)))
}
