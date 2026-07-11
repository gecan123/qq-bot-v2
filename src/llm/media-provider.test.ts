import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { OpenAIProvider } from './openai-adapter.js'
import { buildMediaProvider } from './media-provider.js'

const providers = {
  openai: { url: 'http://127.0.0.1:8317/v1', apiKey: 'sk-openai' },
  gemini: { url: 'http://127.0.0.1:8318/v1', apiKey: 'sk-gemini' },
}

describe('buildMediaProvider', () => {
  test('creates a scenario route when reasoning effort is the only override', () => {
    const routing = buildMediaProvider({
      defaultProvider: 'openai',
      defaultModel: 'gpt-default',
      providers,
      scenarios: { describeImage: { reasoningEffort: 'low' } },
    })

    const route = routing.getProviderForScenario('describeImage')
    assert.ok(route instanceof OpenAIProvider)
    assert.equal(route.model, 'gpt-default')
    assert.equal((route as unknown as { reasoningEffort: string }).reasoningEffort, 'low')
  })

  test('uses an explicit provider and model for a scenario', () => {
    const routing = buildMediaProvider({
      defaultProvider: 'openai',
      defaultModel: 'gpt-default',
      providers,
      scenarios: { describePdf: { provider: 'gemini', model: 'gemini-pdf' } },
    })

    const route = routing.getProviderForScenario('describePdf') as OpenAIProvider
    assert.equal(route.model, 'gemini-pdf')
  })

  test('rejects an unknown scenario provider instead of silently using the default route', () => {
    assert.throws(
      () => buildMediaProvider({
        defaultProvider: 'openai',
        defaultModel: 'gpt-default',
        providers,
        scenarios: { transcribeAudio: { provider: 'missing' } },
      }),
      /transcribeAudio references unknown provider: missing/,
    )
  })
})
