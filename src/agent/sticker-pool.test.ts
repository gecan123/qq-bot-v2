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

  test('renders a bounded summary and points to on-demand lookup', async () => {
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
    assert.match(summary, /显示前/)
    assert.match(summary, /按需/)
    assert.match(summary, /#100/)
    assert.doesNotMatch(summary, new RegExp(`#${100 + STICKER_POOL_SUMMARY_LIMIT}`))
    assert.ok(summary.length <= STICKER_POOL_SUMMARY_MAX_CHARS)
  })
})
