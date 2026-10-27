import type { Settings } from '../config/settings'
import { ReviewError } from './pr'
import { deriveEndpoints, type Provider, type ProviderKind, providerKinds } from './provider'
import { readProvider } from './slots'

type Fetch = typeof fetch

const timeout = 60_000
const maxBodyChars = 300
const providerWidth = Math.max(...providerKinds.map((kind) => kind.length))

export function modelsRequest({ kind, baseUrl, apiKey }: Provider): { url: string; headers: Record<string, string> } {
  const url = `${deriveEndpoints(kind, baseUrl).responses}/models`
  return { url, headers: kind === 'foundry' ? { 'api-key': apiKey } : { Authorization: `Bearer ${apiKey}` } }
}

function isModelList(value: unknown): value is { data: { id: string }[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    Array.isArray(value.data) &&
    value.data.every((model: unknown) => typeof model === 'object' && model !== null && 'id' in model && typeof model.id === 'string')
  )
}

async function get(url: string, headers: Record<string, string>, fetchModels: Fetch): Promise<Response> {
  try {
    return await fetchModels(url, { headers, signal: AbortSignal.timeout(timeout) })
  } catch (error) {
    throw new ReviewError(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function providerModels(provider: Provider, fetchModels: Fetch): Promise<string[]> {
  const { url, headers } = modelsRequest(provider)
  const response = await get(url, headers, fetchModels)
  if (!response.ok)
    throw new ReviewError(`${url} returned HTTP ${response.status}: ${(await response.text()).trim().slice(0, maxBodyChars)}`)
  const body: unknown = await response.json()
  if (!isModelList(body)) throw new ReviewError(`${url} returned an unexpected model list`)
  return body.data.map(({ id }) => `${provider.kind.padEnd(providerWidth)}  ${id}`)
}

function isConfigured(settings: Settings, kind: ProviderKind): boolean {
  return Boolean(settings[`${kind}.baseUrl`] || settings[`${kind}.apiKey`])
}

export async function listModels(settings: Settings, fetchModels: Fetch = fetch): Promise<string[]> {
  const kinds = providerKinds.filter((kind) => isConfigured(settings, kind))
  if (!kinds.length)
    throw new ReviewError(
      `No model provider is configured; set ${providerKinds.map((kind) => `${kind}.baseUrl and ${kind}.apiKey`).join(', or ')} (see \`yoke config\`)`,
    )
  const providers = kinds.map((kind) => readProvider(settings, kind))
  const errors = providers.flatMap((provider) => (Array.isArray(provider) ? provider : []))
  if (errors.length) throw new ReviewError(['Model provider settings are incomplete:', ...errors.map((error) => `- ${error}`)].join('\n'))
  const ready = providers.filter((provider): provider is Provider => !Array.isArray(provider))
  const lists = await Promise.all(ready.map((provider) => providerModels(provider, fetchModels)))
  return lists.flat().toSorted()
}
