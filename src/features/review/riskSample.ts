import { ReviewError } from './pr'
import type { PullInfo } from './riskInputs'
import type { AppClient } from './riskMerge'
import type { RiskPolicy } from './riskPolicy'

export const sampledMarker = 'sampled for a human check'

const percent = (rate: number): string => `${Math.round(rate * 1000) / 10}%`

function failure(error: unknown): string {
  if (error instanceof ReviewError) return error.message
  throw error
}

async function attempt(done: string, failed: string, call: () => Promise<unknown>): Promise<string> {
  try {
    await call()
    return done
  } catch (error) {
    return `${failed}: ${failure(error)}`
  }
}

export type Sampled = { reason: string; fresh: boolean }

export function rollSample(pull: PullInfo, policy: RiskPolicy, random: () => number): Sampled | null {
  const { rate, label } = policy.sample
  const otherwise = `it would otherwise have been ${policy.mode === 'merge' ? 'approved and auto-merged' : 'approved'} by \`yoke-review\`, so it needs a manual approval`
  if (pull.labels.some(({ name }) => name === label))
    return { reason: `already ${sampledMarker} (labelled \`${label}\`): ${otherwise}`, fresh: false }
  if (rate <= 0 || random() >= rate) return null
  return { reason: `${sampledMarker}, one of ${percent(rate)} of low-risk PRs: ${otherwise}`, fresh: true }
}

export async function markSampled(repo: string, pull: PullInfo, policy: RiskPolicy, app: AppClient): Promise<string[]> {
  const { label } = policy.sample
  return [
    await attempt(`labelled \`${label}\``, `the \`${label}\` label could not be added`, () =>
      app.post(`repos/${repo}/issues/${pull.number}/labels`, { labels: [label] }),
    ),
  ]
}
