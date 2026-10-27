import { describe, expect, it } from 'vitest'

import type { Harness } from './harness'
import { ReviewError } from './pr'
import { assertViable, type Checks } from './preflight'
import type { ProbeRequest } from './provider'
import type { ReviewSlots } from './slots'

const ownAuth: ReviewSlots = { claude: { harness: 'claude' }, codex: { harness: 'codex' } }

const probe = (url: string): ProbeRequest => ({ url, headers: {}, body: {} })

type Fake = { missing?: Harness[]; signedOut?: Harness[]; unreachable?: Record<string, string> }

function fake({ missing = [], signedOut = [], unreachable = {} }: Fake = {}): Checks & { reached: string[] } {
  const reached: string[] = []
  return {
    reached,
    onPath: async (harness) => !missing.includes(harness),
    signedIn: async (harness) => !signedOut.includes(harness),
    reach: async ({ url }) => {
      reached.push(url)
      return unreachable[url]
    },
  }
}

async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ReviewError) return error.message
    throw error
  }
  throw new Error('expected a ReviewError')
}

describe('assertViable', () => {
  it('passes when both CLIs are installed and signed in', async () => {
    await expect(assertViable(ownAuth, fake())).resolves.toBeUndefined()
  })

  it('names a signed-out harness and how to sign in', async () => {
    const message = await errorOf(() => assertViable(ownAuth, fake({ signedOut: ['codex'] })))
    expect(message.split('\n')).toEqual([
      'Cannot review:',
      '- codex is not signed in (review.reviewer2); run `codex login`, or run it through LiteLLM or Foundry by setting review.reviewer2.provider and review.reviewer2.model (see `yoke models`)',
    ])
  })

  it('names every slot that shares a signed-out harness', async () => {
    const message = await errorOf(() => assertViable(ownAuth, fake({ signedOut: ['claude'] })))
    expect(message).toContain(
      '- claude is not signed in (review.reviewer1, review.synthesis); run `claude auth login`, or run it through LiteLLM or Foundry by setting review.reviewer1.provider and review.reviewer1.model, and review.synthesis.provider and review.synthesis.model (see `yoke models`)',
    )
  })

  it('names every missing CLI', async () => {
    const message = await errorOf(() => assertViable(ownAuth, fake({ missing: ['claude', 'codex'] })))
    expect(message.split('\n')).toEqual([
      'Cannot review:',
      '- claude CLI not found on PATH; install it',
      '- codex CLI not found on PATH; install it',
    ])
  })

  it('probes a provider slot instead of checking sign-in', async () => {
    const slots: ReviewSlots = { ...ownAuth, codex: { harness: 'codex', model: 'gpt-5', probe: probe('https://p/v1/responses') } }
    const checks = fake({ signedOut: ['codex'], unreachable: { 'https://p/v1/responses': 'HTTP 401: bad key' } })
    const message = await errorOf(() => assertViable(slots, checks))
    expect(message.split('\n')).toEqual(['Cannot review:', '- codex model "gpt-5" at https://p/v1/responses: HTTP 401: bad key'])
  })

  it('checks own-auth sign-in for an unset synthesis slot even when every reviewer uses the provider', async () => {
    const slots: ReviewSlots = {
      claude: { harness: 'claude', model: 'sonnet', probe: probe('https://p/v1/messages') },
      codex: { harness: 'codex', model: 'gpt-5', probe: probe('https://p/v1/responses') },
    }
    const message = await errorOf(() => assertViable(slots, fake({ signedOut: ['claude'] })))
    expect(message).toContain('- claude is not signed in (review.synthesis); run `claude auth login`')
  })

  it('probes each distinct model once', async () => {
    const slot = { harness: 'claude' as const, model: 'sonnet', probe: probe('https://p/v1/messages') }
    const checks = fake()
    await assertViable({ claude: slot, codex: { harness: 'codex' }, synthesis: slot }, checks)
    expect(checks.reached).toEqual(['https://p/v1/messages'])
  })
})
