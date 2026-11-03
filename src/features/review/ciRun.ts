import { type PostDeps, postFailure } from './post'
import type { PullRequest } from './request'
import { type StatusUi, timed } from './status'

export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_ACTIONS === 'true'
}

export function ciRunUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
}

export async function reportFailure(pr: PullRequest, reason: string, ui: StatusUi, deps: PostDeps): Promise<void> {
  try {
    await timed(ui, `posting the failed review to #${pr.number}`, () => postFailure(pr, reason, ciRunUrl(), deps))
  } catch (error) {
    ui.log(`could not post the failed review: ${error instanceof Error ? error.message : String(error)}`)
  }
}
