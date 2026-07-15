import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { prisma } from '../database/client.js'
import {
  renderStickerPoolSummary,
  STICKER_POOL_SUMMARY_LIMIT,
  STICKER_POOL_SUMMARY_MAX_CHARS,
} from './sticker-pool.js'

describe('sticker pool summary', () => {
  let originalFindMany: typeof prisma.stickerPool.findMany
  let capturedFindMany: unknown

  beforeEach(() => {
    capturedFindMany = null
    originalFindMany = prisma.stickerPool.findMany
  })

  afterEach(() => {
    prisma.stickerPool.findMany = originalFindMany
  })

  test('renders a bounded structured payload with media refs', async () => {
    prisma.stickerPool.findMany = (async (args: unknown) => {
      capturedFindMany = args
      return Array.from({ length: STICKER_POOL_SUMMARY_LIMIT + 1 }, (_, i) => ({
        mediaId: 100 + i,
        name: `表情${i}`,
        tags: ['测试'],
        description: `描述${i} ${'x'.repeat(500)}`,
      }))
    }) as never

    const summary = await renderStickerPoolSummary()

    assert.ok(summary)
    assert.deepEqual(capturedFindMany, {
      orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
      take: STICKER_POOL_SUMMARY_LIMIT + 1,
      select: { mediaId: true, name: true, tags: true, description: true },
    })
    const payload = JSON.parse(summary)
    assert.equal(payload.source, 'sticker_pool')
    assert.ok(payload.stickers.length <= STICKER_POOL_SUMMARY_LIMIT)
    assert.ok(payload.stickers.length > 0)
    assert.equal(payload.stickers[0].mediaId, 100)
    assert.equal(payload.stickers[0].mediaRef, 'media:100')
    assert.equal(payload.truncated, true)
    assert.equal(summary.includes('#100'), false)
    assert.ok(summary.length <= STICKER_POOL_SUMMARY_MAX_CHARS)
  })
})
