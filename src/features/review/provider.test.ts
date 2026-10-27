import { describe, expect, it } from 'vitest'

import { buildOverride, buildProbe, deriveEndpoints } from './provider'

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
})
