import type { Harness } from './harness'

export const providerKinds = ['litellm', 'foundry'] as const

export type ProviderKind = (typeof providerKinds)[number]

export type Credential = { apiKey: string } | { token: string }

export type Provider = { kind: ProviderKind; baseUrl: string } & Credential

export type Endpoints = { anthropic: string; responses: string }

export type PiModel = { baseUrl: string; model: string; contextWindow?: number }

export type Override = { args: string[]; env: Record<string, string>; pi?: PiModel }

const harnesses: Harness[] = ['claude', 'codex', 'pi']

export const piKeyEnv = 'YOKE_PI_API_KEY'

function codexKeyEnv(provider: Provider): string {
  return `YOKE_${provider.kind.toUpperCase()}_${'token' in provider ? 'TOKEN' : 'API_KEY'}`
}

export function credentialOf(provider: Credential): string {
  return 'token' in provider ? provider.token : provider.apiKey
}

export function isProviderKind(value: string): value is ProviderKind {
  return (providerKinds as readonly string[]).includes(value)
}

export function deriveEndpoints(kind: ProviderKind, baseUrl: string): Endpoints {
  const base = baseUrl.replace(/\/+$/, '')
  if (kind === 'foundry') return { anthropic: `${base}/anthropic`, responses: `${base}/openai/v1` }
  return { anthropic: base, responses: `${base}/v1` }
}

export type SlotModel = { harness: Harness; model: string; contextWindow?: number }

export function isHarness(value: string): value is Harness {
  return (harnesses as string[]).includes(value)
}

export function ownAuthOverride({ harness, model }: SlotModel): Override {
  return { args: harness === 'codex' ? ['-m', model] : ['--model', model], env: {} }
}

function buildCodexOverride(provider: Provider, endpoints: Endpoints, model: string): Override {
  const keyEnv = codexKeyEnv(provider)
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
    env: { [keyEnv]: credentialOf(provider) },
  }
}

function buildPiOverride(provider: Provider, endpoints: Endpoints, model: string, contextWindow: number | undefined): Override {
  return {
    args: ['--model', `yoke/${model}`],
    env: { [piKeyEnv]: credentialOf(provider) },
    pi: { baseUrl: endpoints.responses, model, ...(contextWindow ? { contextWindow } : {}) },
  }
}

const piMaxTokens = 32_000

const piContextWindow = 200_000

const probePrompt = 'ping'

// pi's clampMaxTokensToContext (pi-ai 1.5.2) estimates input at 3.5 characters a token, counting only the
// messages, and keeps a 4,096 token margin. The probe's input is far too small for pi's other margin to apply.
function probeMaxTokens(contextWindow: number): number {
  const input = Math.ceil(probePrompt.length / 3.5)
  return Math.min(piMaxTokens, Math.max(1, contextWindow - input - 4_096))
}

export function piModels({ baseUrl, model, contextWindow = piContextWindow }: PiModel): unknown {
  const entry = {
    id: model,
    name: model,
    reasoning: true,
    input: ['text'],
    contextWindow,
    maxTokens: Math.min(piMaxTokens, contextWindow),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // pi guesses these from the base URL (a proxy host containing deepseek.com flips most of them),
    // so pin them to the request buildProbe sends.
    compat: {
      supportsDeveloperRole: true,
      supportsStore: true,
      maxTokensField: 'max_completion_tokens',
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      thinkingFormat: 'openai',
      supportsStrictMode: false,
    },
  }
  return { providers: { yoke: { baseUrl, api: 'openai-completions', apiKey: `$${piKeyEnv}`, models: [entry] } } }
}

function claudeProviderEnv(provider: Provider, endpoints: Endpoints): Record<string, string> {
  if (provider.kind === 'foundry' && 'apiKey' in provider)
    return { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: endpoints.anthropic, ANTHROPIC_FOUNDRY_API_KEY: provider.apiKey }
  return { ANTHROPIC_BASE_URL: endpoints.anthropic, ANTHROPIC_AUTH_TOKEN: credentialOf(provider) }
}

function buildClaudeOverride(provider: Provider, endpoints: Endpoints, model: string): Override {
  return {
    args: ['--model', model],
    env: {
      ...claudeProviderEnv(provider, endpoints),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
    },
  }
}

export type ProbeRequest = { url: string; headers: Record<string, string>; body: unknown }

function claudeAuthHeaders(provider: Provider): Record<string, string> {
  if ('token' in provider) return { Authorization: `Bearer ${provider.token}` }
  if (provider.kind === 'foundry') return { 'x-api-key': provider.apiKey }
  return { Authorization: `Bearer ${provider.apiKey}`, 'x-api-key': provider.apiKey }
}

export function buildProbe({ harness, model, contextWindow = piContextWindow }: SlotModel, provider: Provider): ProbeRequest {
  const endpoints = deriveEndpoints(provider.kind, provider.baseUrl)
  const bearer = { Authorization: `Bearer ${credentialOf(provider)}` }
  if (harness === 'codex')
    return { url: `${endpoints.responses}/responses`, headers: bearer, body: { model, input: 'ping', max_output_tokens: 16 } }
  if (harness === 'pi')
    return {
      url: `${endpoints.responses}/chat/completions`,
      headers: bearer,
      body: {
        model,
        messages: [
          { role: 'developer', content: 'Reply briefly.' },
          { role: 'user', content: probePrompt },
        ],
        stream: true,
        stream_options: { include_usage: true },
        store: false,
        max_completion_tokens: probeMaxTokens(contextWindow),
        tools: [{ type: 'function', function: { name: 'ping', description: 'Ping.', parameters: { type: 'object', properties: {} } } }],
        reasoning_effort: 'medium',
      },
    }
  return {
    url: `${endpoints.anthropic}/v1/messages`,
    headers: { ...claudeAuthHeaders(provider), 'anthropic-version': '2023-06-01' },
    body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
  }
}

export function buildOverride({ harness, model, contextWindow }: SlotModel, provider: Provider): Override {
  const endpoints = deriveEndpoints(provider.kind, provider.baseUrl)
  if (harness === 'codex') return buildCodexOverride(provider, endpoints, model)
  if (harness === 'pi') return buildPiOverride(provider, endpoints, model, contextWindow)
  return buildClaudeOverride(provider, endpoints, model)
}
