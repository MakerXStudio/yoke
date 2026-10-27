import { describe, expect, it } from 'vitest'

import { listModels, modelsRequest } from './models'
import { ReviewError } from './pr'

const litellm = { 'modelProvider.kind': 'litellm', 'modelProvider.baseUrl': 'https://llm/', 'modelProvider.apiKey': 'k' }

function respond(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status })
}

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
  it('returns the model ids sorted', async () => {
    const models = await listModels(litellm, respond(200, { data: [{ id: 'bedrock/opus' }, { id: 'azure/gpt-5' }] }))
    expect(models).toEqual(['azure/gpt-5', 'bedrock/opus'])
  })

  it('names every missing provider setting', async () => {
    const message = await errorOf(() => listModels({}, respond(200, { data: [] })))
    expect(message.split('\n')).toHaveLength(4)
    expect(message).toContain('- modelProvider.apiKey is not set')
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
})
