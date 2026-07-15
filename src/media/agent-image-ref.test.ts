import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { computeMediaHash } from './media-hash.js'
import { createAgentImageRefStore } from './agent-image-ref.js'

describe('agent image refs', () => {
  test('persists base64 bytes with a content-addressed upsert and returns a stable ref', async () => {
    const bytes = Buffer.from('durable-image')
    let captured: unknown
    const store = createAgentImageRefStore({
      media: {
        async upsert(args: unknown) { captured = args; return { mediaId: 42 } },
        async findUnique() { return null },
      },
    })

    const ref = await store.persist({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
    }, { description: 'saved description' })

    assert.deepEqual(ref, {
      type: 'image_ref', mediaId: '42', mediaType: 'image/png', description: 'saved description',
    })
    const args = captured as {
      where: { dataHash: string }
      create: {
        data: Uint8Array
        dataHash: string
        contentType: string
        mediaType: string
        fileSize: number
        descriptionRaw: unknown
      }
      update: unknown
      select: unknown
    }
    assert.equal(args.where.dataHash, computeMediaHash(bytes))
    assert.deepEqual(Buffer.from(args.create.data), bytes)
    assert.equal(args.create.dataHash, computeMediaHash(bytes))
    assert.equal(args.create.contentType, 'image/png')
    assert.equal(args.create.mediaType, 'image')
    assert.equal(args.create.fileSize, bytes.length)
    assert.deepEqual(args.create.descriptionRaw, {
      description: 'saved description', source: 'agent_tool_result',
    })
    assert.deepEqual(args.update, {})
    assert.deepEqual(args.select, { mediaId: true })
  })

  test('hydrates a ref from Media and returns null when the row is unavailable', async () => {
    const bytes = Buffer.from('restored-image')
    let available = true
    const store = createAgentImageRefStore({
      media: {
        async upsert() { return { mediaId: 7 } },
        async findUnique() {
          return available ? { data: new Uint8Array(bytes), contentType: 'image/webp' } : null
        },
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
