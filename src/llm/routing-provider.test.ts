import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RoutingProvider } from './routing-provider.js'
import type { LlmProvider } from './types.js'

describe('RoutingProvider', () => {
  test('describeImageDetailed delegates to the image scenario provider', async () => {
    const calls: unknown[] = []
    const imageProvider: LlmProvider = {
      describeImage: async () => 'image description',
      describeImageDetailed: async (params) => {
        calls.push(params)
        return { description: 'image description', raw: { description: 'image description' } }
      },
    }
    const defaultProvider: LlmProvider = {
      describeImage: async () => {
        throw new Error('default should not be called for describeImage')
      },
    }

    const provider = new RoutingProvider(defaultProvider, { describeImage: imageProvider })
    const result = await provider.describeImageDetailed({
      image: Buffer.from('image'),
      contentType: 'image/jpeg',
    })

    assert.equal(result.description, 'image description')
    assert.equal(calls.length, 1)
  })

  test('describeImageDetailed propagates errors from the underlying provider', async () => {
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

  test('describeImageDetailed falls back to describeImage when describeImageDetailed is not implemented', async () => {
    const provider = new RoutingProvider({
      describeImage: async () => 'plain description',
    })

    const result = await provider.describeImageDetailed({
      image: Buffer.from('image'),
      contentType: 'image/jpeg',
    })

    assert.equal(result.description, 'plain description')
  })
})
