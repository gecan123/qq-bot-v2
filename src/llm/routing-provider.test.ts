import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RoutingProvider } from './routing-provider.js'
import type { LlmProvider } from './types.js'

describe('RoutingProvider image fallback', () => {
  test('falls back to image fallback provider when primary throws', async () => {
    const primaryCalls: unknown[] = []
    const fallbackCalls: unknown[] = []

    const primary: LlmProvider = {
      describeImage: async () => {
        throw new Error('429')
      },
      describeImageDetailed: async (params) => {
        primaryCalls.push(params)
        throw new Error('429')
      },
    }

    const fallback: LlmProvider = {
      describeImage: async () => 'fallback description',
      describeImageDetailed: async (params) => {
        fallbackCalls.push(params)
        return { description: 'fallback description', raw: { description: 'fallback description' } }
      },
    }

    const provider = new RoutingProvider(primary, { describeImageFallback: fallback })
    const result = await provider.describeImageDetailed({
      image: Buffer.from('image'),
      contentType: 'image/jpeg',
    })

    assert.equal(result.description, 'fallback description')
    assert.equal(primaryCalls.length, 1)
    assert.equal(fallbackCalls.length, 1)
  })

  test('rethrows primary error when no image fallback provider is configured', async () => {
    const provider = new RoutingProvider({
      describeImage: async () => {
        throw new Error('boom')
      },
      describeImageDetailed: async () => {
        throw new Error('boom')
      },
    })

    await assert.rejects(
      () =>
        provider.describeImageDetailed({
          image: Buffer.from('image'),
          contentType: 'image/jpeg',
        }),
      /boom/,
    )
  })
})
