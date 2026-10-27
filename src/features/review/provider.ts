import type { Harness } from './harness'

export const providerKinds = ['litellm', 'foundry'] as const

export type ProviderKind = (typeof providerKinds)[number]

export type Provider = { kind: ProviderKind; baseUrl: string; apiKey: string }

export type Endpoints = { anthropic: string; responses: string }

export type Override = { args: string[]; env: Record<string, string> }

const harnesses: Harness[] = ['claude', 'codex']

function codexKeyEnv(kind: ProviderKind): string {
  return `YOKE_${kind.toUpperCase()}_API_KEY`
}

export function isProviderKind(value: string): value is ProviderKind {
  return (providerKinds as readonly string[]).includes(value)
}

export function deriveEndpoints(kind: ProviderKind, baseUrl: string): Endpoints {
  const base = baseUrl.replace(/\/+$/, '')
  if (kind === 'foundry') return { anthropic: `${base}/anthropic`, responses: `${base}/openai/v1` }
  return { anthropic: base, responses: `${base}/v1` }
}

export type SlotModel = { harness: Harness; model: string }

export function isHarness(value: string): value is Harness {
  return (harnesses as string[]).includes(value)
}

export function ownAuthOverride({ harness, model }: SlotModel): Override {
  return { args: harness === 'codex' ? ['-m', model] : ['--model', model], env: {} }
}

function buildCodexOverride({ kind, apiKey }: Provider, endpoints: Endpoints, model: string): Override {
  const keyEnv = codexKeyEnv(kind)
  return {
    args: [
      '-c',
      'model_providers.yoke.name=yoke',
      '-c',
      `model_providers.yoke.base_url=${endpoints.responses}`,
      '-c',
      `model_providers.yoke.env_key=${keyEnv}`,
      '-c',
      'model_providers.yoke.wire_api=responses',
      '-c',
      'model_provider=yoke',
      '-m',
      model,
    ],
    env: { [keyEnv]: apiKey },
  }
}

function claudeProviderEnv(kind: ProviderKind, endpoints: Endpoints, apiKey: string): Record<string, string> {
  if (kind === 'foundry')
    return { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: endpoints.anthropic, ANTHROPIC_FOUNDRY_API_KEY: apiKey }
  return { ANTHROPIC_BASE_URL: endpoints.anthropic, ANTHROPIC_AUTH_TOKEN: apiKey }
}

function buildClaudeOverride(provider: Provider, endpoints: Endpoints, model: string): Override {
  return {
    args: ['--model', model],
    env: {
      ...claudeProviderEnv(provider.kind, endpoints, provider.apiKey),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
    },
  }
}

export type ProbeRequest = { url: string; headers: Record<string, string>; body: unknown }

function claudeAuthHeaders({ kind, apiKey }: Provider): Record<string, string> {
  if (kind === 'foundry') return { 'x-api-key': apiKey }
  return { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey }
}

export function buildProbe({ harness, model }: SlotModel, provider: Provider): ProbeRequest {
  const endpoints = deriveEndpoints(provider.kind, provider.baseUrl)
  if (harness === 'codex')
    return {
      url: `${endpoints.responses}/responses`,
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      body: { model, input: 'ping', max_output_tokens: 16 },
    }
  return {
    url: `${endpoints.anthropic}/v1/messages`,
    headers: { ...claudeAuthHeaders(provider), 'anthropic-version': '2023-06-01' },
    body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
  }
}

export function buildOverride({ harness, model }: SlotModel, provider: Provider): Override {
  const endpoints = deriveEndpoints(provider.kind, provider.baseUrl)
  if (harness === 'codex') return buildCodexOverride(provider, endpoints, model)
  return buildClaudeOverride(provider, endpoints, model)
}
