import { appendFileSync } from 'node:fs'

import { earlierRuns, gateContext, type GateContext, type GateDeps, reviewJob } from './gate'
import { githubGet } from './pr'

export type PushDecision = { review: boolean; message: string }

export async function pushReview(context: GateContext, deps: Pick<GateDeps, 'get'>): Promise<PushDecision> {
  if (context.eventName !== 'pull_request' || context.event.action !== 'synchronize')
    return { review: false, message: 'Only a push to a PR decides here whether to run the review.' }
  for (const run of await earlierRuns(context, deps)) {
    const review = await reviewJob(context.repo, run, deps)
    if (review && review.conclusion !== 'skipped') {
      const url = `${context.serverUrl}/${context.repo}/actions/runs/${run}`
      return { review: false, message: `A review already started for this PR, in run ${url}, so this push skips it.` }
    }
  }
  return { review: true, message: 'No review has started for this PR yet, so this push runs one.' }
}

export async function runPushReview(out: (message: string) => void, env = process.env): Promise<void> {
  const { review, message } = await pushReview(gateContext(env, 'yoke review-push'), { get: (path: string) => githubGet(path) })
  out(message)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `review=${review}\n`)
}
