import { describe, expect, it } from 'vitest'

import { buildOverride, buildProbe, deriveEndpoints, ownAuthOverride, piModels } from './provider'

describe('buildProbe', () => {
  it('pings the Codex responses endpoint with a bearer key', () => {
    expect(buildProbe({ harness: 'codex', model: 'gpt-5' }, { kind: 'litellm', baseUrl: 'https://llm', apiKey: 'k' })).toEqual({
      url: 'https://llm/v1/responses',
      headers: { Authorization: 'Bearer k' },
      body: { model: 'gpt-5', input: 'ping', max_output_tokens: 16 },
    })
  })

  it('pings the Foundry messages endpoint with x-api-key', () => {
    const probe = buildProbe({ harness: 'claude', model: 'sonnet' }, { kind: 'foundry', baseUrl: 'https://res', apiKey: 'k' })
    expect(probe.url).toBe('https://res/anthropic/v1/messages')
    expect(probe.headers).toEqual({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' })
  })

  it('pings Foundry with an Entra token as a bearer token on both paths', () => {
    const provider = { kind: 'foundry', baseUrl: 'https://res', token: 't' } as const
    expect(buildProbe({ harness: 'claude', model: 'sonnet' }, provider).headers).toEqual({
      Authorization: 'Bearer t',
      'anthropic-version': '2023-06-01',
    })
    expect(buildProbe({ harness: 'codex', model: 'gpt-5' }, provider)).toMatchObject({
      url: 'https://res/openai/v1/responses',
      headers: { Authorization: 'Bearer t' },
    })
  })
})

describe('deriveEndpoints', () => {
  it('uses the LiteLLM root for Claude and /v1 for Codex', () => {
    expect(deriveEndpoints('litellm', 'https://llm.example/')).toEqual({
      anthropic: 'https://llm.example',
      responses: 'https://llm.example/v1',
    })
  })

  it('uses the Foundry anthropic and openai/v1 paths', () => {
    expect(deriveEndpoints('foundry', 'https://res.services.ai.azure.com')).toEqual({
      anthropic: 'https://res.services.ai.azure.com/anthropic',
      responses: 'https://res.services.ai.azure.com/openai/v1',
    })
  })
})

describe('buildOverride', () => {
  it('points codex exec at the provider responses endpoint with the key in an env var', () => {
    expect(buildOverride({ harness: 'codex', model: 'gpt-5-codex' }, { kind: 'litellm', baseUrl: 'https://llm', apiKey: 'k' })).toEqual({
      args: [
        '-c',
        'model_providers.yoke.name=yoke',
        '-c',
        'model_providers.yoke.base_url=https://llm/v1',
        '-c',
        'model_providers.yoke.env_key=YOKE_LITELLM_API_KEY',
        '-c',
        'model_providers.yoke.wire_api=responses',
        '-c',
        'model_provider=yoke',
        '-m',
        'gpt-5-codex',
      ],
      env: { YOKE_LITELLM_API_KEY: 'k' },
    })
  })

  const pinned = {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'sonnet-x',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-x',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'sonnet-x',
    CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet-x',
  }

  it('gives Claude the LiteLLM base URL and auth token with every alias pinned', () => {
    expect(buildOverride({ harness: 'claude', model: 'sonnet-x' }, { kind: 'litellm', baseUrl: 'https://llm', apiKey: 'k' })).toEqual({
      args: ['--model', 'sonnet-x'],
      env: { ANTHROPIC_BASE_URL: 'https://llm', ANTHROPIC_AUTH_TOKEN: 'k', ...pinned },
    })
  })

  it('switches Claude to Foundry with the anthropic endpoint and key', () => {
    expect(buildOverride({ harness: 'claude', model: 'sonnet-x' }, { kind: 'foundry', baseUrl: 'https://res', apiKey: 'k' })).toEqual({
      args: ['--model', 'sonnet-x'],
      env: { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: 'https://res/anthropic', ANTHROPIC_FOUNDRY_API_KEY: 'k', ...pinned },
    })
  })

  const entra = { kind: 'foundry', baseUrl: 'https://res', token: 't' } as const

  it('sends Claude an Entra token as a bearer auth token at the Foundry anthropic endpoint', () => {
    expect(buildOverride({ harness: 'claude', model: 'sonnet-x' }, entra)).toEqual({
      args: ['--model', 'sonnet-x'],
      env: { ANTHROPIC_BASE_URL: 'https://res/anthropic', ANTHROPIC_AUTH_TOKEN: 't', ...pinned },
    })
  })

  it('gives Codex an Entra token through its bearer env key', () => {
    const { args, env } = buildOverride({ harness: 'codex', model: 'gpt-5-codex' }, entra)
    expect(args).toContain('model_providers.yoke.base_url=https://res/openai/v1')
    expect(args).toContain('model_providers.yoke.env_key=YOKE_FOUNDRY_TOKEN')
    expect(env).toEqual({ YOKE_FOUNDRY_TOKEN: 't' })
  })
})

describe('pi', () => {
  it('passes the model to pi on its own login', () => {
    expect(ownAuthOverride({ harness: 'pi', model: 'openai/gpt-5' })).toEqual({ args: ['--model', 'openai/gpt-5'], env: {} })
  })

  it.each([
    ['litellm', { kind: 'litellm', baseUrl: 'https://llm', apiKey: 'k' }, 'https://llm/v1', 'k'],
    ['foundry', { kind: 'foundry', baseUrl: 'https://res', apiKey: 'k' }, 'https://res/openai/v1', 'k'],
    ['foundry with Entra', { kind: 'foundry', baseUrl: 'https://res', token: 't' }, 'https://res/openai/v1', 't'],
  ] as const)('points pi at the %s chat completions base with the credential in YOKE_PI_API_KEY', (_, provider, baseUrl, credential) => {
    expect(buildOverride({ harness: 'pi', model: 'kimi' }, provider)).toEqual({
      args: ['--model', 'yoke/kimi'],
      env: { YOKE_PI_API_KEY: credential },
      pi: { baseUrl, model: 'kimi' },
    })
    expect(buildProbe({ harness: 'pi', model: 'kimi' }, provider)).toEqual({
      url: `${baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${credential}` },
      body: {
        model: 'kimi',
        messages: [
          { role: 'developer', content: 'Reply briefly.' },
          { role: 'user', content: 'ping' },
        ],
        stream: true,
        stream_options: { include_usage: true },
        store: false,
        max_completion_tokens: 32000,
        tools: [{ type: 'function', function: { name: 'ping', description: 'Ping.', parameters: { type: 'object', properties: {} } } }],
        reasoning_effort: 'medium',
      },
    })
  })

  it('writes one yoke provider whose key pi reads from the environment', () => {
    expect(piModels({ baseUrl: 'https://llm/v1', model: 'kimi' })).toEqual({
      providers: {
        yoke: {
          baseUrl: 'https://llm/v1',
          api: 'openai-completions',
          apiKey: '$YOKE_PI_API_KEY',
          models: [
            {
              id: 'kimi',
              name: 'kimi',
              reasoning: true,
              input: ['text'],
              contextWindow: 200000,
              maxTokens: 32000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: {
                supportsDeveloperRole: true,
                supportsStore: true,
                maxTokensField: 'max_completion_tokens',
                supportsUsageInStreaming: true,
                supportsReasoningEffort: true,
                thinkingFormat: 'openai',
                supportsStrictMode: false,
              },
            },
          ],
        },
      },
    })
  })

  it('caps the model entry and the probe by a small context window', () => {
    const provider = { kind: 'litellm', baseUrl: 'https://llm', apiKey: 'k' } as const
    const override = buildOverride({ harness: 'pi', model: 'kimi', contextWindow: 16_000 }, provider)
    expect(override.pi).toEqual({ baseUrl: 'https://llm/v1', model: 'kimi', contextWindow: 16_000 })
    expect(piModels(override.pi!)).toMatchObject({ providers: { yoke: { models: [{ contextWindow: 16_000, maxTokens: 16_000 }] } } })
    expect(buildProbe({ harness: 'pi', model: 'kimi', contextWindow: 16_000 }, provider).body).toMatchObject({
      max_completion_tokens: 16_000 - 2 - 4_096,
    })
    expect(buildProbe({ harness: 'pi', model: 'kimi', contextWindow: 1_000_000 }, provider).body).toMatchObject({
      max_completion_tokens: 32_000,
    })
  })

  it('pins the compat settings so a proxy host name cannot change what pi sends', () => {
    expect(piModels({ baseUrl: 'https://deepseek.company.com/v1', model: 'kimi' })).toMatchObject({
      providers: {
        yoke: {
          models: [
            {
              compat: {
                supportsDeveloperRole: true,
                supportsStore: true,
                maxTokensField: 'max_completion_tokens',
                supportsUsageInStreaming: true,
                supportsReasoningEffort: true,
                thinkingFormat: 'openai',
                supportsStrictMode: false,
              },
            },
          ],
        },
      },
    })
  })
})
