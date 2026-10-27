import type { Settings } from '../config/settings'
import { ReviewError } from './pr'
import { deriveEndpoints, type Provider } from './provider'
import { readProvider } from './slots'

type Fetch = typeof fetch

const timeout = 60_000
const maxBodyChars = 300

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

export async function listModels(settings: Settings, fetchModels: Fetch = fetch): Promise<string[]> {
  const provider = readProvider(settings)
  if (Array.isArray(provider))
    throw new ReviewError(['Model provider settings are incomplete:', ...provider.map((error) => `- ${error}`)].join('\n'))
  const { url, headers } = modelsRequest(provider)
  const response = await get(url, headers, fetchModels)
  if (!response.ok)
    throw new ReviewError(`${url} returned HTTP ${response.status}: ${(await response.text()).trim().slice(0, maxBodyChars)}`)
  const body: unknown = await response.json()
  if (!isModelList(body)) throw new ReviewError(`${url} returned an unexpected model list`)
  return body.data.map(({ id }) => id).toSorted()
}
