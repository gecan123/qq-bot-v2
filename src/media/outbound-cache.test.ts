import assert from 'node:assert/strict'
import { describe, test, beforeEach } from 'node:test'
import { OutboundCache } from './outbound-cache.js'

function makeEntry(hash: string, byteSize = 100) {
  return {
    bytes: Buffer.alloc(byteSize, hash.charCodeAt(0)),
    dataHash: hash,
    byteSize,
    contentType: 'image/png',
    description: `test image ${hash.slice(0, 8)}`,
  }
}

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)

describe('OutboundCache', () => {
  let cache: OutboundCache

  beforeEach(() => {
    cache = new OutboundCache({ maxEntries: 4, maxBytes: 1024, ttlMs: 5000 })
  })

  test('put + acquire + release round trip', () => {
    const key = cache.put(makeEntry(HASH_A))
    assert.equal(key, HASH_A)
    assert.equal(cache.size, 1)

    const entry = cache.acquire(key)
    assert.ok(entry)
    assert.equal(entry.dataHash, HASH_A)
    assert.equal(entry.byteSize, 100)
    assert.equal(entry.contentType, 'image/png')
    assert.equal(entry.refcount, 1)

    cache.release(key)
    const after = cache.get(key)
    assert.ok(after)
    assert.equal(after.refcount, 0)
  })

  test('same dataHash reuses the existing entry', () => {
    cache.put(makeEntry(HASH_A))
    const before = cache.get(HASH_A)!
    const createdBefore = before.createdAt

    cache.put(makeEntry(HASH_A))
    const after = cache.get(HASH_A)!
    assert.equal(after, before)
    assert.ok(after.createdAt >= createdBefore)
    assert.equal(cache.size, 1)
  })

  test('same dataHash but different byteSize → first-wins + no duplicate', () => {
    cache.put(makeEntry(HASH_A, 100))
    cache.put(makeEntry(HASH_A, 200))
    const entry = cache.get(HASH_A)!
    assert.equal(entry.byteSize, 100, 'first entry wins')
    assert.equal(cache.size, 1)
  })

  test('TTL expiry: refcount=0 → evict on acquire', async () => {
    const shortCache = new OutboundCache({ maxEntries: 4, maxBytes: 1024, ttlMs: 50 })
    shortCache.put(makeEntry(HASH_A))
    assert.equal(shortCache.size, 1)

    await new Promise((r) => setTimeout(r, 60))

    const entry = shortCache.acquire(HASH_A)
    assert.equal(entry, null, 'expired entry should return null')
    assert.equal(shortCache.size, 0, 'expired entry should be cleaned up')
  })

  test('TTL expiry: refcount>0 → not evicted on get, but acquire returns null', async () => {
    const shortCache = new OutboundCache({ maxEntries: 4, maxBytes: 1024, ttlMs: 50 })
    shortCache.put(makeEntry(HASH_A))
    const acquired = shortCache.acquire(HASH_A)
    assert.ok(acquired)
    assert.equal(acquired.refcount, 1)

    await new Promise((r) => setTimeout(r, 60))

    // acquire returns null (expired) but doesn't delete because refcount > 0
    const expired = shortCache.acquire(HASH_A)
    assert.equal(expired, null)
    assert.equal(shortCache.size, 1, 'entry with refcount>0 should not be deleted on TTL expiry')

    shortCache.release(HASH_A)
    // now acquire should clean up
    const gone = shortCache.acquire(HASH_A)
    assert.equal(gone, null)
    assert.equal(shortCache.size, 0)
  })

  test('LRU eviction: oldest refcount=0 evicted first', () => {
    const tinyCache = new OutboundCache({ maxEntries: 2, maxBytes: 10000, ttlMs: 60000 })
    tinyCache.put(makeEntry(HASH_A, 100))
    tinyCache.put(makeEntry(HASH_B, 100))
    // cache full (maxEntries=2), adding C should evict A (oldest)
    tinyCache.put(makeEntry(HASH_C, 100))

    assert.equal(tinyCache.get(HASH_A), null, 'oldest entry should be evicted')
    assert.ok(tinyCache.get(HASH_B))
    assert.ok(tinyCache.get(HASH_C))
    assert.equal(tinyCache.size, 2)
  })

  test('maxBytes eviction', () => {
    const byteCache = new OutboundCache({ maxEntries: 100, maxBytes: 250, ttlMs: 60000 })
    byteCache.put(makeEntry(HASH_A, 100))
    byteCache.put(makeEntry(HASH_B, 100))
    // 200 bytes used, adding 100 more would be 300 > 250 → evict A
    byteCache.put(makeEntry(HASH_C, 100))

    assert.equal(byteCache.get(HASH_A), null, 'should evict to fit under maxBytes')
    assert.ok(byteCache.get(HASH_B))
    assert.ok(byteCache.get(HASH_C))
    assert.equal(byteCache.currentBytes, 200)
  })

  test('acquire prevents eviction (refcount > 0 skipped during LRU)', () => {
    const tinyCache = new OutboundCache({ maxEntries: 2, maxBytes: 10000, ttlMs: 60000 })
    tinyCache.put(makeEntry(HASH_A, 100))
    tinyCache.put(makeEntry(HASH_B, 100))

    // acquire A so it has refcount > 0
    tinyCache.acquire(HASH_A)

    // add C → should evict B (A is protected by refcount)
    tinyCache.put(makeEntry(HASH_C, 100))

    assert.ok(tinyCache.get(HASH_A), 'acquired entry should not be evicted')
    assert.equal(tinyCache.get(HASH_B), null, 'non-acquired entry should be evicted')
    assert.ok(tinyCache.get(HASH_C))

    tinyCache.release(HASH_A)
  })

  test('all entries have refcount > 0 → eviction stops, cache exceeds maxEntries', () => {
    const tinyCache = new OutboundCache({ maxEntries: 2, maxBytes: 10000, ttlMs: 60000 })
    tinyCache.put(makeEntry(HASH_A, 100))
    tinyCache.put(makeEntry(HASH_B, 100))
    tinyCache.acquire(HASH_A)
    tinyCache.acquire(HASH_B)

    // no victim available → cache grows beyond maxEntries
    tinyCache.put(makeEntry(HASH_C, 100))
    assert.equal(tinyCache.size, 3)

    tinyCache.release(HASH_A)
    tinyCache.release(HASH_B)
  })

  test('release below zero clamps to 0', () => {
    cache.put(makeEntry(HASH_A))
    cache.release(HASH_A)
    cache.release(HASH_A)
    const entry = cache.get(HASH_A)!
    assert.equal(entry.refcount, 0)
  })

  test('acquire on non-existent key returns null', () => {
    assert.equal(cache.acquire('nonexistent'), null)
  })

  test('get on non-existent key returns null', () => {
    assert.equal(cache.get('nonexistent'), null)
  })
})
