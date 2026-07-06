import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import * as zod from 'zod'
import { collectStickerTool } from './collect-sticker.js'
import { prisma } from '../../database/client.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

const rows = [
  {
    id: 10,
    mediaId: 101,
    name: '无语猫',
    tags: ['无语', '猫'],
    description: '一只很无语的猫',
    useCount: 5,
    createdAt: new Date('2026-06-22T01:00:00.000Z'),
  },
  {
    id: 11,
    mediaId: 102,
    name: '开心狗',
    tags: ['开心'],
    description: '适合庆祝',
    useCount: 2,
    createdAt: new Date('2026-06-23T01:00:00.000Z'),
  },
]

describe('collect_sticker tool', () => {
  let originalMediaFindUnique: typeof prisma.media.findUnique
  let originalStickerUpsert: typeof prisma.stickerPool.upsert
  let originalStickerFindMany: typeof prisma.stickerPool.findMany
  let capturedFindMany: unknown
  let capturedUpsert: unknown

  beforeEach(() => {
    capturedFindMany = null
    capturedUpsert = null
    originalMediaFindUnique = prisma.media.findUnique
    originalStickerUpsert = prisma.stickerPool.upsert
    originalStickerFindMany = prisma.stickerPool.findMany
    prisma.media.findUnique = (async () => ({
      mediaId: 101,
      descriptionRaw: { description: '自动描述' },
    })) as never
    prisma.stickerPool.upsert = (async (args: unknown) => {
      capturedUpsert = args
      return { id: 77 }
    }) as never
    prisma.stickerPool.findMany = (async (args: unknown) => {
      capturedFindMany = args
      return rows
    }) as never
  })

  afterEach(() => {
    prisma.media.findUnique = originalMediaFindUnique
    prisma.stickerPool.upsert = originalStickerUpsert
    prisma.stickerPool.findMany = originalStickerFindMany
  })

  test('schema serializes cleanly to JSON Schema', () => {
    assert.doesNotThrow(() => zod.toJSONSchema(collectStickerTool.schema))
  })

  test('actionless legacy collect args are rejected', () => {
    const parsed = collectStickerTool.schema.safeParse({
      image: { mediaId: 101 },
      name: '无语猫',
      tags: ['无语', '猫'],
      description: '一只很无语的猫',
    })
    assert.equal(parsed.success, false)
  })

  test('action=collect returns one structured result and upserts metadata', async () => {
    const result = await collectStickerTool.execute({
      action: 'collect',
      image: { mediaId: 101 },
      name: '无语猫',
      tags: ['无语', '猫'],
      description: '一只很无语的猫',
    }, makeCtx())
    const parsed = JSON.parse(result.content as string)

    assert.equal(parsed.ok, true)
    assert.equal(parsed.action, 'collect')
    assert.deepEqual(parsed.sticker, { stickerId: 77, mediaId: 101, mediaRef: 'media:101' })
    assert.equal(parsed.pool.stickers[0].mediaRef, 'media:101')
    assert.deepEqual(result.outcome, { ok: true })
    assert.deepEqual(capturedUpsert, {
      where: { mediaId: 101 },
      create: {
        mediaId: 101,
        name: '无语猫',
        tags: ['无语', '猫'],
        description: '一只很无语的猫',
      },
      update: {
        name: '无语猫',
        tags: ['无语', '猫'],
        description: '一只很无语的猫',
      },
      select: { id: true },
    })
  })

  test('action=collect auto-fills description', async () => {
    const result = await collectStickerTool.execute({
      action: 'collect',
      image: { mediaId: 101 },
      name: '开心猫',
      tags: ['开心'],
    }, makeCtx())
    const parsed = JSON.parse(result.content as string)

    assert.equal(parsed.ok, true)
    assert.equal(parsed.sticker.mediaId, 101)
    assert.equal((capturedUpsert as { create: { description: string } }).create.description, '自动描述')
  })

  test('action=list returns bounded media refs ordered by usage and creation time', async () => {
    const result = await collectStickerTool.execute({ action: 'list', limit: 5 }, makeCtx())
    const parsed = JSON.parse(result.content as string) as {
      ok: boolean
      pool: { stickers: { mediaRef: string; name: string; tags: string[]; description: string; useCount: number }[] }
    }

    assert.equal(parsed.ok, true)
    assert.equal(parsed.pool.stickers.length, 2)
    assert.equal(parsed.pool.stickers[0]!.mediaRef, 'media:101')
    assert.equal(parsed.pool.stickers[0]!.name, '无语猫')
    assert.deepEqual(capturedFindMany, {
      where: undefined,
      orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
      take: 6,
      select: {
        id: true,
        mediaId: true,
        name: true,
        tags: true,
        description: true,
        useCount: true,
        createdAt: true,
      },
    })
  })

  test('action=search matches name, tags, or description and caps limit at 20', async () => {
    const result = await collectStickerTool.execute({ action: 'search', query: '猫', limit: 99 }, makeCtx())
    const parsed = JSON.parse(result.content as string) as { ok: boolean; pool: { stickers: { mediaRef: string }[] } }

    assert.equal(parsed.ok, true)
    assert.equal(parsed.pool.stickers[0]!.mediaRef, 'media:101')
    assert.deepEqual(capturedFindMany, {
      where: {
        OR: [
          { name: { contains: '猫', mode: 'insensitive' } },
          { description: { contains: '猫', mode: 'insensitive' } },
          { tags: { has: '猫' } },
        ],
      },
      orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
      take: 21,
      select: {
        id: true,
        mediaId: true,
        name: true,
        tags: true,
        description: true,
        useCount: true,
        createdAt: true,
      },
    })
  })

  test('action=random returns bounded candidates and accepts optional tag', async () => {
    const result = await collectStickerTool.execute({ action: 'random', tag: '开心', limit: 1 }, makeCtx())
    const parsed = JSON.parse(result.content as string) as { ok: boolean; pool: { stickers: { mediaRef: string }[] } }

    assert.equal(parsed.ok, true)
    assert.equal(parsed.pool.stickers.length, 1)
    assert.match(parsed.pool.stickers[0]!.mediaRef, /^media:\d+$/)
    assert.deepEqual(capturedFindMany, {
      where: { tags: { has: '开心' } },
      orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      select: {
        id: true,
        mediaId: true,
        name: true,
        tags: true,
        description: true,
        useCount: true,
        createdAt: true,
      },
    })
  })
})
