import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Harness } from './harness'
import { ReviewError } from './pr'
import { assertViable, type Checks, type PiAuth, piDefaultProvider, piSignIn, type SignIn } from './preflight'
import type { ProbeRequest } from './provider'
import { ReviewFailure } from './run'
import type { ReviewSlots, Slot } from './slots'

const ownAuth: ReviewSlots = { reviewer1: { harness: 'claude' }, reviewer2: { harness: 'codex' } }

const probe = (url: string): ProbeRequest => ({ url, headers: {}, body: {} })

type Fake = { missing?: Harness[]; signedOut?: Harness[]; signIn?: SignIn; unreachable?: Record<string, string> }

function fake({ missing = [], signedOut = [], signIn, unreachable = {} }: Fake = {}): Checks & { reached: string[]; checked: Slot[] } {
  const reached: string[] = []
  const checked: Slot[] = []
  return {
    reached,
    checked,
    onPath: async (harness) => !missing.includes(harness),
    signedIn: async (slot) => {
      checked.push(slot)
      return signIn ?? (signedOut.includes(slot.harness) ? 'signedOut' : 'signedIn')
    },
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

  it('fails as a ReviewFailure so CI posts the failed review', async () => {
    const failure = assertViable(ownAuth, fake({ signedOut: ['codex'] }))
    await expect(failure).rejects.toBeInstanceOf(ReviewFailure)
    await expect(failure).rejects.toMatchObject({ reason: 'a reviewer could not run' })
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
    const slots: ReviewSlots = { ...ownAuth, reviewer2: { harness: 'codex', model: 'gpt-5', probe: probe('https://p/v1/responses') } }
    const checks = fake({ signedOut: ['codex'], unreachable: { 'https://p/v1/responses': 'HTTP 401: bad key' } })
    const message = await errorOf(() => assertViable(slots, checks))
    expect(message.split('\n')).toEqual(['Cannot review:', '- codex model "gpt-5" at https://p/v1/responses: HTTP 401: bad key'])
  })

  it('checks own-auth sign-in for an unset synthesis slot even when every reviewer uses the provider', async () => {
    const slots: ReviewSlots = {
      reviewer1: { harness: 'claude', model: 'sonnet', probe: probe('https://p/v1/messages') },
      reviewer2: { harness: 'codex', model: 'gpt-5', probe: probe('https://p/v1/responses') },
    }
    const message = await errorOf(() => assertViable(slots, fake({ signedOut: ['claude'] })))
    expect(message).toContain('- claude is not signed in (review.synthesis); run `claude auth login`')
  })

  it('probes each distinct model once', async () => {
    const slot = { harness: 'claude' as const, model: 'sonnet', probe: probe('https://p/v1/messages') }
    const checks = fake()
    await assertViable({ reviewer1: slot, reviewer2: { harness: 'codex' }, synthesis: slot }, checks)
    expect(checks.reached).toEqual(['https://p/v1/messages'])
  })
})

describe('assertViable with pi', () => {
  const piProbe = probe('https://p/v1/chat/completions')
  const piSlot: Slot = { harness: 'pi', model: 'kimi', provider: 'litellm', probe: piProbe }

  it("probes an unset synthesis slot as reviewer 1's whole pi slot, not pi's own default", async () => {
    const checks = fake()
    await assertViable({ reviewer1: piSlot, reviewer2: { harness: 'codex' } }, checks)
    expect(checks.reached).toEqual(['https://p/v1/chat/completions'])
    expect(checks.checked.map((slot) => slot.harness)).toEqual(['codex'])
  })

  it('passes the slot to the sign-in check so pi can check its model', async () => {
    const checks = fake()
    await assertViable({ reviewer1: { harness: 'pi', model: 'openai/gpt-5' }, reviewer2: { harness: 'codex' } }, checks)
    expect(checks.checked[0]).toMatchObject({ harness: 'pi', model: 'openai/gpt-5' })
  })

  it('tells a signed-out pi user to sign in from pi', async () => {
    const message = await errorOf(() => assertViable({ ...ownAuth, reviewer1: { harness: 'pi' } }, fake({ signedOut: ['pi'] })))
    expect(message).toContain('- pi is not signed in (review.reviewer1, review.synthesis); run `pi`, then `/login`, or run it through')
  })

  it('names a model pi cannot resolve', async () => {
    const slots: ReviewSlots = { ...ownAuth, reviewer1: { harness: 'pi', model: 'kimi' } }
    const message = await errorOf(() => assertViable(slots, fake({ signIn: 'unresolvedModel' })))
    expect(message).toContain('- pi can\'t resolve model "kimi"; use <provider>/<model> (see pi --list-models)')
  })

  it('stops when pi has no model to run', async () => {
    const message = await errorOf(() => assertViable({ ...ownAuth, reviewer1: { harness: 'pi' } }, fake({ signIn: 'noModel' })))
    expect(message).toContain('- pi has no model: set review.reviewer1.model and review.synthesis.model, or pick a default model in pi')
  })
})

function auth(code: number, defaultProvider?: string): PiAuth & { args: string[][] } {
  const args: string[][] = []
  return {
    args,
    check: async (checked) => {
      args.push(checked)
      return code
    },
    defaultProvider: () => defaultProvider,
  }
}

describe('piSignIn', () => {
  it.each([
    [0, 'signedIn'],
    [1, 'signedOut'],
    [2, 'unresolvedModel'],
  ] as const)('maps `pi auth check --model` exit %i to %s', async (code, state) => {
    const fakeAuth = auth(code)
    expect(await piSignIn('openai/gpt-5', fakeAuth)).toBe(state)
    expect(fakeAuth.args).toEqual([['--model', 'openai/gpt-5']])
  })

  it("checks pi's default provider when the slot has no model", async () => {
    const fakeAuth = auth(0, 'openai-codex')
    expect(await piSignIn(undefined, fakeAuth)).toBe('signedIn')
    expect(fakeAuth.args).toEqual([['--provider', 'openai-codex']])
  })

  it('stops without running pi when there is no model and no default provider', async () => {
    const fakeAuth = auth(0)
    expect(await piSignIn(undefined, fakeAuth)).toBe('noModel')
    expect(fakeAuth.args).toEqual([])
  })
})

describe('piDefaultProvider', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yoke-pi-settings-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("reads defaultProvider from pi's settings in its agent dir", () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'openai-codex', theme: 'dark' }))
    expect(piDefaultProvider({ PI_CODING_AGENT_DIR: dir })).toBe('openai-codex')
  })

  it('has none when the settings file is missing or sets no provider', () => {
    expect(piDefaultProvider({ PI_CODING_AGENT_DIR: dir })).toBeUndefined()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    expect(piDefaultProvider({ PI_CODING_AGENT_DIR: dir })).toBeUndefined()
  })
})
