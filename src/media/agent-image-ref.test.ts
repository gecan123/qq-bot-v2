import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { computeMediaHash } from './media-hash.js'
import { createAgentImageRefStore } from './agent-image-ref.js'

describe('agent image refs', () => {
  test('persists base64 bytes with a content-addressed upsert and returns a stable ref', async () => {
    const bytes = Buffer.from('durable-image')
    let captured: unknown
    const store = createAgentImageRefStore({
      async promote(input) { captured = input; return 42 },
      async resolve() { return null },
    })

    const ref = await store.persist({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
    }, { description: 'saved description' })

    assert.deepEqual(ref, {
      type: 'image_ref', mediaId: '42', mediaType: 'image/png', description: 'saved description',
    })
    const input = captured as {
      bytes: Buffer
      dataHash: string
      contentType: string
      mediaType: string
      description: string
      descriptionSource: string
    }
    assert.deepEqual(input.bytes, bytes)
    assert.equal(input.dataHash, computeMediaHash(bytes))
    assert.equal(input.contentType, 'image/png')
    assert.equal(input.mediaType, 'image')
    assert.equal(input.description, 'saved description')
    assert.equal(input.descriptionSource, 'agent_tool_result')
  })

  test('hydrates a ref from Media and returns null when the row is unavailable', async () => {
    const bytes = Buffer.from('restored-image')
    let available = true
    const store = createAgentImageRefStore({
      async promote() { return 7 },
      async resolve() {
        return available ? {
          bytes,
          dataHash: computeMediaHash(bytes),
          byteSize: bytes.byteLength,
          contentType: 'image/webp',
          description: '',
        } : null
      },
    })
    const ref = { type: 'image_ref' as const, mediaId: '7', mediaType: 'image/webp' }

    assert.deepEqual(await store.resolve(ref), {
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: bytes.toString('base64') },
    })
    available = false
    assert.equal(await store.resolve(ref), null)
  })
})
