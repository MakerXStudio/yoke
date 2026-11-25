import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Harness } from './harness'
import { ReviewError } from './pr'
import { assertViable, type Checks, type PiAuth, piDefaultProvider, piSignIn, reach, type SignIn } from './preflight'
import { buildProbe, type ProbeRequest, type Provider } from './provider'
import { ReviewFailure } from './run'
import type { ReviewSlots, Slot } from './slots'

const ownAuth: ReviewSlots = { reviewer1: { harness: 'claude' }, reviewer2: { harness: 'codex' } }

const probe = (url: string): ProbeRequest => ({ url, headers: {}, body: {} })

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

type Fake = { missing?: Harness[]; signedOut?: Harness[]; signIn?: SignIn; unreachable?: Record<string, string> }

function fake({ missing = [], signedOut = [], signIn, unreachable = {} }: Fake = {}): Checks & {
  reached: string[]
  probes: ProbeRequest[]
  checked: Slot[]
} {
  const reached: string[] = []
  const probes: ProbeRequest[] = []
  const checked: Slot[] = []
  return {
    reached,
    probes,
    checked,
    onPath: async (harness) => !missing.includes(harness),
    signedIn: async (slot) => {
      checked.push(slot)
      return signIn ?? (signedOut.includes(slot.harness) ? 'signedOut' : 'signedIn')
    },
    reach: async (request) => {
      reached.push(request.url)
      probes.push(request)
      return unreachable[request.url]
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
    expect(message.split('\n')).toEqual([
      'Cannot review:',
      '- codex model "gpt-5" at https://p/v1/responses (review.reviewer2): HTTP 401: bad key',
    ])
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
    expect(message).toContain('- pi can\'t resolve model "kimi"; use <provider>/<model> (see pi --list-models), and check ')
  })

  it("says pi's provider is not built in or in models.json, so an extension provider can't be used", async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/pi')
    const slots: ReviewSlots = { ...ownAuth, reviewer1: { harness: 'pi', model: 'myext/m' } }
    const message = await errorOf(() => assertViable(slots, fake({ signIn: 'unknownProvider' })))
    expect(message).toContain(
      `- pi's provider for model "myext/m" is not built in or set in ${join('/pi', 'models.json')} (review.reviewer1, review.synthesis); yoke runs pi without extensions, so Pi extension providers are unavailable to yoke`,
    )
  })

  it("points at pi's models.json when pi can't load its models", async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/pi')
    const message = await errorOf(() => assertViable({ ...ownAuth, reviewer1: { harness: 'pi' } }, fake({ signIn: 'invalidModels' })))
    expect(message).toContain(`- pi can't load its models (review.reviewer1, review.synthesis); fix ${join('/pi', 'models.json')}`)
  })

  it('stops when pi has no model to run', async () => {
    const message = await errorOf(() => assertViable({ ...ownAuth, reviewer1: { harness: 'pi' } }, fake({ signIn: 'noModel' })))
    expect(message).toContain('- pi has no model: set review.reviewer1.model and review.synthesis.model, or pick a default model in pi')
  })

  const litellm: Provider = { kind: 'litellm', baseUrl: 'https://p', apiKey: 'sk-test' }
  const windowed = (contextWindow?: number): Slot => ({
    harness: 'pi',
    model: 'kimi',
    provider: 'litellm',
    contextWindow,
    probe: buildProbe({ harness: 'pi', model: 'kimi', contextWindow }, litellm),
  })

  it('probes one pi model separately for each context window that changes its request', async () => {
    const checks = fake()
    await assertViable({ reviewer1: windowed(16_000), reviewer2: windowed() }, checks)
    expect(checks.probes.map(({ body }) => body)).toMatchObject([{ max_completion_tokens: 11_902 }, { max_completion_tokens: 32_000 }])
  })

  it('probes one pi model once when its context windows send the same request', async () => {
    const checks = fake()
    await assertViable({ reviewer1: windowed(100_000), reviewer2: windowed() }, checks)
    expect(checks.probes.map(({ body }) => body)).toMatchObject([{ max_completion_tokens: 32_000 }])
  })

  it('probes each provider even when their requests are identical', async () => {
    const foundry: Provider = { kind: 'foundry', baseUrl: 'https://res', apiKey: 'sk-foundry' }
    const viaLitellm = buildProbe({ harness: 'pi', model: 'kimi' }, { kind: 'litellm', baseUrl: 'https://res/openai', apiKey: 'sk-test' })
    const viaFoundry = buildProbe({ harness: 'pi', model: 'kimi' }, foundry)
    expect(viaFoundry.url).toBe(viaLitellm.url)
    const checks = fake()
    await assertViable(
      {
        reviewer1: { harness: 'pi', model: 'kimi', provider: 'litellm', probe: viaLitellm },
        reviewer2: { harness: 'pi', model: 'kimi', provider: 'foundry', probe: viaFoundry },
      },
      checks,
    )
    expect(checks.probes.map(({ headers }) => headers.Authorization)).toEqual(['Bearer sk-test', 'Bearer sk-foundry'])
  })

  it('names the slots a failed probe covers', async () => {
    const url = 'https://p/v1/chat/completions'
    const checks = fake({ unreachable: { [url]: 'HTTP 400: max_completion_tokens too large' } })
    const message = await errorOf(() => assertViable({ reviewer1: windowed(16_000), reviewer2: windowed() }, checks))
    expect(message.split('\n')).toEqual([
      'Cannot review:',
      `- pi model "kimi" at ${url} (review.reviewer1, review.synthesis): HTTP 400: max_completion_tokens too large`,
      `- pi model "kimi" at ${url} (review.reviewer2): HTTP 400: max_completion_tokens too large`,
    ])
  })
})

function auth(code: number, defaultProvider?: string, stdout = ''): PiAuth & { args: string[][] } {
  const args: string[][] = []
  return {
    args,
    check: async (checked) => {
      args.push(checked)
      return { code, stdout }
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

  it.each([
    [1, '{"status":"not_ready","provider":"myext","reason":"provider_not_found"}', undefined, 'unknownProvider'],
    [1, '{"status":"not_ready","provider":"openai","reason":"credentials_not_configured"}', undefined, 'signedOut'],
    [2, '{"status":"invalid","provider":"openai","reason":"invalid_state"}', undefined, 'invalidModels'],
    [2, '{"status":"invalid","provider":"kimi","reason":"invalid_state"}', 'kimi', 'unresolvedModel'],
    [1, 'not json', undefined, 'signedOut'],
    [2, '', undefined, 'noModel'],
  ] as const)('maps exit %i with `%s` to %s', async (code, stdout, model, state) => {
    expect(await piSignIn(model, auth(code, 'openai', stdout))).toBe(state)
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

function failWith(status: number, body: string): void {
  vi.stubGlobal('fetch', async () => new Response(body, { status }))
}

describe('reach', () => {
  it('redacts the credential and key shapes from a failed probe body, keeping the status and safe text', async () => {
    failWith(401, 'bad key secret-1 for model kimi; Bearer abc sk-live_2 api_key=plain Key Hash (Token) = 9f3a1c')
    const error = await reach({ url: 'https://p/v1/chat/completions', headers: { Authorization: 'Bearer secret-1' }, body: {} })
    expect(error).not.toMatch(/secret-1|abc|sk-live_2|plain|9f3a1c/)
    expect(error).toBe(
      'HTTP 401: bad key [redacted] for model kimi; [redacted] [redacted] api_key=[redacted] Key Hash (Token) = [redacted]',
    )
  })

  it('redacts an x-api-key credential before capping the body at 300 characters', async () => {
    failWith(400, `${'x'.repeat(295)}key-abcdefgh`)
    const error = await reach({ url: 'https://p/v1/messages', headers: { 'x-api-key': 'key-abcdefgh' }, body: {} })
    expect(error).toBe(`HTTP 400: ${'x'.repeat(295)}[reda`)
  })

  it('passes a plain JSON 2xx reply', async () => {
    failWith(200, JSON.stringify({ id: 'msg_1', content: [] }))
    expect(await reach({ url: 'https://p/v1/messages', headers: {}, body: {} })).toBeUndefined()
  })

  it('passes a streamed reply after its first event and cancels the rest of the stream', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) =>
        controller.enqueue(new TextEncoder().encode(': keep-alive\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')),
      cancel,
    })
    vi.stubGlobal('fetch', async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    expect(await reach({ url: 'https://p/v1/chat/completions', headers: {}, body: {} })).toBeUndefined()
    expect(cancel).toHaveBeenCalled()
  })

  it('fails a streamed reply whose first event is an error, redacting the credential', async () => {
    const event = { error: { message: 'reasoning with tools is not supported for secret-1', code: 400 } }
    failWith(200, `data: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\r\n\r\n`)
    const error = await reach({ url: 'https://p/v1/chat/completions', headers: { Authorization: 'Bearer secret-1' }, body: {} })
    expect(error).toBe('HTTP 200 with error: reasoning with tools is not supported for [redacted]')
  })

  it('fails a JSON 2xx reply that carries an error payload', async () => {
    failWith(200, JSON.stringify({ error: 'model not deployed' }))
    expect(await reach({ url: 'https://p/v1/chat/completions', headers: {}, body: {} })).toBe('HTTP 200 with error: model not deployed')
  })
})
