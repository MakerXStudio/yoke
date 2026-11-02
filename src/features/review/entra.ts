import type { Settings } from '../config/settings'
import { ReviewError } from './pr'

type Fetch = typeof fetch

const tokenExchangeAudience = 'api://AzureADTokenExchange'

const cognitiveServicesScope = 'https://cognitiveservices.azure.com/.default'

const timeout = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorDetail(json: Record<string, unknown>, text: string): string {
  const detail = [json.error_description, json.error, json.message].find((value) => typeof value === 'string')
  return typeof detail === 'string' ? detail : text.trim()
}

async function readJson(response: Response, failure: string): Promise<Record<string, unknown>> {
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ReviewError(`${failure}: HTTP ${response.status}: ${text.trim().slice(0, 300)}`)
  }
  const json = isRecord(body) ? body : {}
  if (response.ok) return json
  throw new ReviewError(`${failure}: HTTP ${response.status}: ${errorDetail(json, text).slice(0, 300)}`)
}

async function githubOidcToken(env: NodeJS.ProcessEnv, fetchFn: Fetch): Promise<string> {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = env
  if (!url || !bearer) throw new ReviewError("No GitHub OIDC token endpoint; grant id-token: write in the calling workflow's permissions")
  const request = new URL(url)
  request.searchParams.set('audience', tokenExchangeAudience)
  const response = await fetchFn(request, { headers: { Authorization: `bearer ${bearer}` }, signal: AbortSignal.timeout(timeout) })
  const { value } = await readJson(response, 'GitHub OIDC token request failed')
  if (typeof value !== 'string' || !value) throw new ReviewError('GitHub OIDC token response had no value')
  return value
}

async function exchangeForEntraToken(clientId: string, tenantId: string, env: NodeJS.ProcessEnv, fetchFn: Fetch = fetch): Promise<string> {
  const assertion = await githubOidcToken(env, fetchFn)
  const response = await fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      scope: cognitiveServicesScope,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    }),
    signal: AbortSignal.timeout(timeout),
  })
  const { access_token: token } = await readJson(response, `Entra token exchange for client ${clientId} failed`)
  if (typeof token !== 'string' || !token) throw new ReviewError('Entra token response had no access_token')
  return token
}

export type EntraDeps = { env: NodeJS.ProcessEnv; fetch?: Fetch; mask: (secret: string) => void }

export async function withEntraToken(settings: Settings, { env, fetch: fetchFn = fetch, mask }: EntraDeps): Promise<Settings> {
  const clientId = settings['foundry.azureClientId']
  const tenantId = settings['foundry.azureTenantId']
  if (!clientId && !tenantId) return settings
  if (!clientId || !tenantId) throw new ReviewError('Entra auth needs both foundry.azureClientId and foundry.azureTenantId')
  if (settings['foundry.token']) return settings
  const token = await exchangeForEntraToken(clientId, tenantId, env, fetchFn)
  mask(token)
  return { ...settings, 'foundry.token': token }
}
