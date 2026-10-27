import type { Harness } from './harness'

export const providerKinds = ['litellm', 'foundry'] as const

export type ProviderKind = (typeof providerKinds)[number]

export type Provider = { kind: ProviderKind; baseUrl: string; apiKey: string }

export type Endpoints = { anthropic: string; responses: string }

export type Override = { args: string[]; env: Record<string, string> }

const harnesses: Harness[] = ['claude', 'codex']

const codexKeyEnv = 'YOKE_MODEL_PROVIDER_API_KEY'

export function isProviderKind(value: string): value is ProviderKind {
  return (providerKinds as readonly string[]).includes(value)
}

export function deriveEndpoints(kind: ProviderKind, baseUrl: string): Endpoints {
  const base = baseUrl.replace(/\/+$/, '')
  if (kind === 'foundry') return { anthropic: `${base}/anthropic`, responses: `${base}/openai/v1` }
  return { anthropic: base, responses: `${base}/v1` }
}

export type SlotModel = { harness: Harness; model: string }

function isHarness(value: string): value is Harness {
  return (harnesses as string[]).includes(value)
}

export type ParsedSlot = { harness: Harness; model?: string; viaProvider: boolean }

const providerSuffix = '@provider'

export function parseSlot(value: string): ParsedSlot | null {
  const trimmed = value.trim()
  const viaProvider = trimmed.endsWith(providerSuffix)
  const spec = viaProvider ? trimmed.slice(0, -providerSuffix.length) : trimmed
  const separator = spec.indexOf(':')
  const harness = (separator === -1 ? spec : spec.slice(0, separator)).trim()
  const model = separator === -1 ? undefined : spec.slice(separator + 1).trim()
  if (!isHarness(harness) || model === '' || (viaProvider && !model)) return null
  return model ? { harness, model, viaProvider } : { harness, viaProvider }
}

export const slotFormat = `<claude|codex>[:<model>][${providerSuffix}], with a model when using ${providerSuffix}`

export function ownAuthOverride({ harness, model }: SlotModel): Override {
  return { args: harness === 'codex' ? ['-m', model] : ['--model', model], env: {} }
}

function buildCodexOverride(endpoints: Endpoints, apiKey: string, model: string): Override {
  return {
    args: [
      '-c',
      'model_providers.yoke.name=yoke',
      '-c',
      `model_providers.yoke.base_url=${endpoints.responses}`,
      '-c',
      `model_providers.yoke.env_key=${codexKeyEnv}`,
      '-c',
      'model_providers.yoke.wire_api=responses',
      '-c',
      'model_provider=yoke',
      '-m',
      model,
    ],
    env: { [codexKeyEnv]: apiKey },
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
  if (harness === 'codex') return buildCodexOverride(endpoints, provider.apiKey, model)
  return buildClaudeOverride(provider, endpoints, model)
}
