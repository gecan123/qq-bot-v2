import assert from 'node:assert/strict'
import { describe, test, beforeEach, afterEach } from 'node:test'
import { OutboundCache, setOutboundCacheForTest } from './outbound-cache.js'
import { prisma } from '../database/client.js'
import { resolveImageHandle, resolvePersistedImage, releaseHandle } from './image-handle.js'

const HASH_A = 'a'.repeat(64)

describe('resolveImageHandle (ephemeralRef path)', () => {
  let cache: OutboundCache

  beforeEach(() => {
    cache = new OutboundCache({ maxEntries: 10, maxBytes: 10000, ttlMs: 5000 })
    setOutboundCacheForTest(cache)
  })

  afterEach(() => {
    setOutboundCacheForTest(null)
  })

  test('resolve ephemeralRef acquires and returns image data', async () => {
    cache.put({
      bytes: Buffer.from('test-image-data'),
      dataHash: HASH_A,
      byteSize: 15,
      contentType: 'image/png',
      description: 'test image',
    })

    const result = await resolveImageHandle({ ephemeralRef: HASH_A })
    assert.equal(result.dataHash, HASH_A)
    assert.equal(result.byteSize, 15)
    assert.equal(result.contentType, 'image/png')
    assert.equal(result.description, 'test image')

    const entry = cache.get(HASH_A)!
    assert.equal(entry.refcount, 1, 'acquire should increment refcount')

    releaseHandle({ ephemeralRef: HASH_A })
    const afterRelease = cache.get(HASH_A)!
    assert.equal(afterRelease.refcount, 0, 'release should decrement refcount')
  })

  test('resolve ephemeralRef with acquire:false does not increment refcount', async () => {
    cache.put({
      bytes: Buffer.from('test'),
      dataHash: HASH_A,
      byteSize: 4,
      contentType: 'image/png',
      description: 'test',
    })

    const result = await resolveImageHandle({ ephemeralRef: HASH_A }, { acquire: false })
    assert.equal(result.dataHash, HASH_A)
    assert.equal(cache.get(HASH_A)!.refcount, 0, 'should not increment refcount')
  })

  test('resolve expired ephemeralRef throws', async () => {
    const shortCache = new OutboundCache({ maxEntries: 10, maxBytes: 10000, ttlMs: 1 })
    setOutboundCacheForTest(shortCache)

    shortCache.put({
      bytes: Buffer.from('test'),
      dataHash: HASH_A,
      byteSize: 4,
      contentType: 'image/png',
      description: 'test',
    })

    await new Promise((r) => setTimeout(r, 10))

    await assert.rejects(
      () => resolveImageHandle({ ephemeralRef: HASH_A }),
      /expired or not found/,
    )
  })
})

describe('resolvePersistedImage', () => {
  test('accepts a durable string media id and returns null for missing media', async () => {
    const original = prisma.media.findUnique
    let available = true
    prisma.media.findUnique = (async (args: { where: { mediaId: number } }) => {
      assert.equal(args.where.mediaId, 42)
      return available ? {
        data: new Uint8Array(Buffer.from('image')),
        dataHash: 'hash',
        contentType: 'image/png',
        descriptionRaw: { description: 'saved description' },
      } : null
    }) as never
    try {
      assert.deepEqual(await resolvePersistedImage('42'), {
        bytes: Buffer.from('image'),
        dataHash: 'hash',
        byteSize: 5,
        contentType: 'image/png',
        description: 'saved description',
      })
      available = false
      assert.equal(await resolvePersistedImage('42'), null)
      await assert.rejects(() => resolvePersistedImage('not-an-id'), /invalid media id/)
    } finally {
      prisma.media.findUnique = original
    }
  })
})
