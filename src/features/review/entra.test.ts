import { describe, expect, it, vi } from 'vitest'

import { withEntraToken } from './entra'

const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token?x=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token' }

const entra = { 'foundry.azureClientId': 'client', 'foundry.azureTenantId': 'tenant' }

function respond(...bodies: [number, string][]) {
  const fetch = vi.fn<typeof globalThis.fetch>()
  for (const [status, body] of bodies) fetch.mockResolvedValueOnce(new Response(body, { status }))
  return fetch
}

describe('withEntraToken', () => {
  it('leaves settings without Entra IDs alone', async () => {
    const fetch = respond()
    expect(await withEntraToken({ 'foundry.apiKey': 'k' }, { env, fetch, mask: vi.fn() })).toEqual({ 'foundry.apiKey': 'k' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('exchanges the GitHub OIDC token for a masked Entra token', async () => {
    const fetch = respond([200, '{"value":"oidc"}'], [200, '{"access_token":"entra"}'])
    const mask = vi.fn()
    expect(await withEntraToken(entra, { env, fetch, mask })).toEqual({ ...entra, 'foundry.token': 'entra' })
    expect(mask).toHaveBeenCalledWith('entra')
    const [oidcUrl, oidcInit] = fetch.mock.calls[0] ?? []
    expect(oidcUrl instanceof URL && oidcUrl.href).toBe('https://oidc.example/token?x=1&audience=api%3A%2F%2FAzureADTokenExchange')
    expect(oidcInit?.headers).toEqual({ Authorization: 'bearer request-token' })
    const [entraUrl, entraInit] = fetch.mock.calls[1] ?? []
    expect(entraUrl).toBe('https://login.microsoftonline.com/tenant/oauth2/v2.0/token')
    const body = entraInit?.body
    expect(body instanceof URLSearchParams && Object.fromEntries(body)).toMatchObject({ client_id: 'client', client_assertion: 'oidc' })
  })

  it('needs both IDs', async () => {
    await expect(withEntraToken({ 'foundry.azureClientId': 'client' }, { env, mask: vi.fn() })).rejects.toThrow(/needs both/)
  })

  it('asks for id-token: write without an OIDC endpoint', async () => {
    await expect(withEntraToken(entra, { env: {}, mask: vi.fn() })).rejects.toThrow(/grant id-token: write/)
  })

  it('reports the Entra error description', async () => {
    const fetch = respond([200, '{"value":"oidc"}'], [400, '{"error":"invalid_client","error_description":"AADSTS700213: no match"}'])
    await expect(withEntraToken(entra, { env, fetch, mask: vi.fn() })).rejects.toThrow(
      'Entra token exchange for client client failed: HTTP 400: AADSTS700213: no match',
    )
  })

  it('reports a non-JSON reply instead of a parse error', async () => {
    const fetch = respond([200, '{"value":"oidc"}'], [502, '<html>Bad Gateway</html>'])
    await expect(withEntraToken(entra, { env, fetch, mask: vi.fn() })).rejects.toThrow(
      'Entra token exchange for client client failed: HTTP 502: <html>Bad Gateway</html>',
    )
  })
})
