import { createLogger } from '../logger.js'

const log = createLogger('OUTBOUND_CACHE')

export interface CacheEntry {
  readonly bytes: Buffer
  readonly dataHash: string
  readonly byteSize: number
  readonly contentType: string
  readonly description: string
  createdAt: number
  refcount: number
}

export interface OutboundCacheOptions {
  maxEntries: number
  maxBytes: number
  ttlMs: number
}

const DEFAULTS: OutboundCacheOptions = {
  maxEntries: 32,
  maxBytes: 100 * 1024 * 1024,
  ttlMs: 60 * 60 * 1000,
}

export class OutboundCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly ttlMs: number
  private totalBytes = 0

  constructor(opts: Partial<OutboundCacheOptions> = {}) {
    const merged = { ...DEFAULTS, ...opts }
    this.maxEntries = merged.maxEntries
    this.maxBytes = merged.maxBytes
    this.ttlMs = merged.ttlMs
  }

  put(entry: {
    bytes: Buffer
    dataHash: string
    byteSize: number
    contentType: string
    description: string
  }): string {
    const key = entry.dataHash
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.byteSize !== entry.byteSize) {
        log.error(
          { key, existingSize: existing.byteSize, newSize: entry.byteSize },
          'outbound_cache_hash_collision_or_bug',
        )
        return key
      }
      existing.createdAt = Date.now()
      return key
    }

    this.evictUntilFits(entry.byteSize)

    const cacheEntry: CacheEntry = {
      bytes: entry.bytes,
      dataHash: entry.dataHash,
      byteSize: entry.byteSize,
      contentType: entry.contentType,
      description: entry.description,
      createdAt: Date.now(),
      refcount: 0,
    }
    this.entries.set(key, cacheEntry)
    this.totalBytes += entry.byteSize
    return key
  }

  acquire(key: string): CacheEntry | null {
    const e = this.entries.get(key)
    if (!e) return null
    if (Date.now() - e.createdAt > this.ttlMs) {
      if (e.refcount === 0) {
        this.totalBytes -= e.byteSize
        this.entries.delete(key)
      }
      return null
    }
    e.refcount++
    return e
  }

  release(key: string): void {
    const e = this.entries.get(key)
    if (!e) return
    e.refcount = Math.max(0, e.refcount - 1)
  }

  get(key: string): CacheEntry | null {
    const e = this.entries.get(key)
    if (!e) return null
    if (Date.now() - e.createdAt > this.ttlMs) {
      if (e.refcount === 0) {
        this.totalBytes -= e.byteSize
        this.entries.delete(key)
      }
      return null
    }
    return e
  }

  get size(): number {
    return this.entries.size
  }

  get currentBytes(): number {
    return this.totalBytes
  }

  private evictUntilFits(incomingBytes: number): void {
    while (
      this.entries.size >= this.maxEntries ||
      this.totalBytes + incomingBytes > this.maxBytes
    ) {
      const victim = this.findLruVictim()
      if (!victim) break
      this.totalBytes -= victim.byteSize
      this.entries.delete(victim.dataHash)
      log.info(
        { key: victim.dataHash, byteSize: victim.byteSize, remaining: this.entries.size },
        'outbound_cache_evict',
      )
    }
  }

  private findLruVictim(): CacheEntry | null {
    let oldest: CacheEntry | null = null
    for (const entry of this.entries.values()) {
      if (entry.refcount > 0) continue
      if (!oldest || entry.createdAt < oldest.createdAt) {
        oldest = entry
      }
    }
    return oldest
  }
}

let _instance: OutboundCache | null = null

export function initOutboundCache(opts: Partial<OutboundCacheOptions> = {}): OutboundCache {
  _instance = new OutboundCache(opts)
  return _instance
}

export function getOutboundCache(): OutboundCache {
  if (!_instance) {
    _instance = new OutboundCache()
  }
  return _instance
}

export function setOutboundCacheForTest(cache: OutboundCache | null): void {
  _instance = cache
}
