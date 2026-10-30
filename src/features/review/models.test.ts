import { describe, expect, it } from 'vitest'

import { listModels, modelsRequest } from './models'
import { ReviewError } from './pr'

const litellm = { 'litellm.baseUrl': 'https://llm/', 'litellm.apiKey': 'k' }

function respond(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status })
}

const respondHtml: typeof fetch = async () => new Response('<html>LiteLLM</html>', { status: 200 })

async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ReviewError) return error.message
    throw error
  }
  throw new Error('expected a ReviewError')
}

describe('modelsRequest', () => {
  it('asks LiteLLM for /v1/models with a bearer key', () => {
    expect(modelsRequest({ kind: 'litellm', baseUrl: 'https://llm/', apiKey: 'k' })).toEqual({
      url: 'https://llm/v1/models',
      headers: { Authorization: 'Bearer k' },
    })
  })

  it('asks Foundry for /openai/v1/models with an api-key header', () => {
    expect(modelsRequest({ kind: 'foundry', baseUrl: 'https://res', apiKey: 'k' })).toEqual({
      url: 'https://res/openai/v1/models',
      headers: { 'api-key': 'k' },
    })
  })
})

describe('listModels', () => {
  it('returns each provider and model id, sorted', async () => {
    const models = await listModels(litellm, respond(200, { data: [{ id: 'bedrock/opus' }, { id: 'azure/gpt-5' }] }))
    expect(models).toEqual(['litellm  azure/gpt-5', 'litellm  bedrock/opus'])
  })

  it('lists every configured provider', async () => {
    const both = { ...litellm, 'foundry.baseUrl': 'https://res', 'foundry.apiKey': 'k' }
    const models = await listModels(both, respond(200, { data: [{ id: 'gpt-5' }] }))
    expect(models).toEqual(['foundry  gpt-5', 'litellm  gpt-5'])
  })

  it('says how to configure a provider when none is', async () => {
    expect(await errorOf(() => listModels({}, respond(200, { data: [] })))).toBe(
      'No model provider is configured; set litellm.baseUrl and litellm.apiKey, or foundry.baseUrl and foundry.apiKey (see `yoke config`)',
    )
  })

  it('names the missing setting of a half-configured provider', async () => {
    const message = await errorOf(() => listModels({ 'foundry.baseUrl': 'https://res' }, respond(200, { data: [] })))
    expect(message.split('\n')).toEqual([
      'Model provider settings are incomplete:',
      '- foundry.apiKey is not set; set YOKE_FOUNDRY_API_KEY or run `yoke config set --user foundry.apiKey <key>`',
    ])
  })

  it('reports the status and body of a failed request', async () => {
    const message = await errorOf(() => listModels(litellm, respond(401, { error: 'bad key' })))
    expect(message).toBe('https://llm/v1/models returned HTTP 401: {"error":"bad key"}')
  })

  it('rejects a response that is not a model list', async () => {
    expect(await errorOf(() => listModels(litellm, respond(200, { models: [] })))).toBe(
      'https://llm/v1/models returned an unexpected model list',
    )
  })

  it('rejects a response that is not JSON', async () => {
    expect(await errorOf(() => listModels(litellm, respondHtml))).toBe('https://llm/v1/models returned an unexpected model list')
  })
})
