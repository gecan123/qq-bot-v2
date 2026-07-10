import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from '../database/client.js'
import type { Message } from '../generated/prisma/client.js'
import { jobQueue } from '../queue/runtime.js'
import { resolveMessage } from './message-resolver.js'
import { persistMediaReferences } from './media-cache.js'

const originalFindMany = prisma.media.findMany
const originalCreate = prisma.media.create
const originalFindUnique = prisma.media.findUnique
const originalUpdate = prisma.media.update
const originalEnqueueAndWait = jobQueue.enqueueAndWait
const originalEnqueue = jobQueue.enqueue
const originalFetch = globalThis.fetch

function makeMessage(content: unknown): Message {
  return {
    id: 1,
    sceneKind: 'qq_group',
    sceneExternalId: '1',
    groupId: BigInt(1),
    groupName: '测试群',
    mediaReferenceIds: ['42'],
    messageId: BigInt(100),
    senderId: BigInt(200),
    senderNickname: '测试用户',
    senderGroupNickname: null,
    content: content as Message['content'],
    rawContent: null,
    rawMessage: null,
    searchText: '',
    resolvedText: null,
    sentAt: null,
    createdAt: new Date(0),
  }
}

afterEach(() => {
  prisma.media.findMany = originalFindMany
  prisma.media.create = originalCreate
  prisma.media.findUnique = originalFindUnique
  prisma.media.update = originalUpdate
  jobQueue.enqueueAndWait = originalEnqueueAndWait
  jobQueue.enqueue = originalEnqueue
  globalThis.fetch = originalFetch
})

describe('resolveMessage', () => {
  test('enqueues description generation without waiting when timeoutMs is 0', async () => {
    const calls: Array<{ type: string; data: { mediaId: number }; options: { priority?: string } | undefined }> = []

    prisma.media.findMany = (async () => {
      return [{ mediaId: 42 }]
    }) as unknown as typeof prisma.media.findMany

    jobQueue.enqueueAndWait = (async (type: string, data: { mediaId: number }, options?: { priority?: string }) => {
      calls.push({ type, data, options })
    }) as typeof jobQueue.enqueueAndWait

    const resolved = await resolveMessage(makeMessage([{ type: 'video', referenceId: '42' }]), {
      timeoutMs: 0,
    })

    assert.deepEqual(calls, [
      { type: 'generate-description', data: { mediaId: 42 }, options: { priority: 'high' } },
    ])
    assert.deepEqual(resolved, [{ type: 'video', referenceId: '42' }])
  })

  test('reuses the same background generation job across repeated timeoutMs=0 reads', async () => {
    const calls: Array<{ type: string; data: { mediaId: number }; options: { priority?: string } | undefined }> = []
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })

    prisma.media.findMany = (async () => {
      return [{ mediaId: 42 }]
    }) as unknown as typeof prisma.media.findMany

    jobQueue.enqueueAndWait = (async (type: string, data: { mediaId: number }, options?: { priority?: string }) => {
      calls.push({ type, data, options })
      await blocker
    }) as typeof jobQueue.enqueueAndWait

    await Promise.all([
      resolveMessage(makeMessage([{ type: 'video', referenceId: '42' }]), { timeoutMs: 0 }),
      resolveMessage(makeMessage([{ type: 'video', referenceId: '42' }]), { timeoutMs: 0 }),
    ])

    assert.equal(calls.length, 1)
    release()
    await blocker
  })

  test('waits for description generation when timeoutMs is positive', async () => {
    const calls: Array<{ type: string; data: { mediaId: number }; options: { priority?: string } | undefined }> = []
    let findManyCount = 0

    prisma.media.findMany = (async () => {
      findManyCount += 1
      if (findManyCount === 1) return [{ mediaId: 42 }]
      return [{ mediaId: 42, descriptionRaw: { description: '视频描述', summary: '摘要' } }]
    }) as unknown as typeof prisma.media.findMany

    jobQueue.enqueueAndWait = (async (type: string, data: { mediaId: number }, options?: { priority?: string }) => {
      calls.push({ type, data, options })
    }) as typeof jobQueue.enqueueAndWait

    const resolved = await resolveMessage(makeMessage([{ type: 'video', referenceId: '42' }]), {
      timeoutMs: 1000,
    })

    assert.deepEqual(calls, [
      { type: 'generate-description', data: { mediaId: 42 }, options: { priority: 'high' } },
    ])
    assert.deepEqual(resolved, [
      {
        type: 'video',
        referenceId: '42',
        mediaDescription: { description: '视频描述', summary: '摘要' },
      },
    ])
  })

  test('waits for an in-flight media download before scheduling description generation', async () => {
    const store = new Map<number, { mediaId: number; data: Uint8Array; descriptionRaw: unknown }>()
    const calls: Array<{ type: string; data: { mediaId: number }; options: { priority?: string } | undefined }> = []
    let releaseFetch!: () => void
    const fetchBlocker = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })

    prisma.media.create = (async () => {
      const row = { mediaId: 42, data: new Uint8Array(0), descriptionRaw: null }
      store.set(42, row)
      return row
    }) as unknown as typeof prisma.media.create
    prisma.media.findUnique = (async () => null) as typeof prisma.media.findUnique
    prisma.media.update = (async (args: { where: { mediaId: number }; data: { data?: Uint8Array; descriptionRaw?: unknown } }) => {
      const row = store.get(args.where.mediaId)
      if (!row) throw new Error('missing media')
      if (args.data.data) row.data = args.data.data
      if (args.data.descriptionRaw !== undefined) row.descriptionRaw = args.data.descriptionRaw
      return row
    }) as unknown as typeof prisma.media.update
    prisma.media.findMany = (async (args: { select?: { descriptionRaw?: boolean } }) => {
      const row = store.get(42)
      if (!row) return []
      if (args.select?.descriptionRaw) {
        return row.descriptionRaw ? [{ mediaId: 42, descriptionRaw: row.descriptionRaw }] : []
      }
      return row.descriptionRaw ? [] : [{ mediaId: 42 }]
    }) as unknown as typeof prisma.media.findMany
    jobQueue.enqueue = (() => {}) as typeof jobQueue.enqueue
    jobQueue.enqueueAndWait = (async (type: string, data: { mediaId: number }, options?: { priority?: string }) => {
      calls.push({ type, data, options })
      await prisma.media.update({
        where: { mediaId: data.mediaId },
        data: { descriptionRaw: { description: '下载后描述' } },
      })
    }) as typeof jobQueue.enqueueAndWait
    globalThis.fetch = (async () => {
      await fetchBlocker
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as typeof fetch

    const mediaResult = await persistMediaReferences({
      content: [{ type: 'image', url: 'https://example.test/a.png' }],
      scope: { kind: 'group', groupId: 1 },
      messageId: 100,
      senderId: 200,
      napcat: {} as never,
    })
    const resolving = resolveMessage(makeMessage(mediaResult.content), { timeoutMs: 1000 })

    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(calls, [])

    releaseFetch()
    const resolved = await resolving

    assert.deepEqual(calls, [
      { type: 'generate-description', data: { mediaId: 42 }, options: { priority: 'high' } },
    ])
    assert.deepEqual(resolved, [
      {
        type: 'image',
        referenceId: '42',
        url: undefined,
        mediaDescription: { description: '下载后描述' },
      },
    ])
  })

  test('resolves descriptions for media nested inside forwarded messages', async () => {
    let findManyCount = 0
    prisma.media.findMany = (async () => {
      findManyCount += 1
      if (findManyCount === 1) return []
      return [{ mediaId: 42, descriptionRaw: { description: '转发图片描述' } }]
    }) as unknown as typeof prisma.media.findMany

    const resolved = await resolveMessage(makeMessage([{
      type: 'forward',
      forwardId: 'forward-1',
      items: [{
        senderId: '101',
        content: [{ type: 'image', referenceId: '42' }],
      }],
    }]), { timeoutMs: 1000 })

    assert.deepEqual(resolved, [{
      type: 'forward',
      forwardId: 'forward-1',
      items: [{
        senderId: '101',
        content: [{
          type: 'image',
          referenceId: '42',
          mediaDescription: { description: '转发图片描述' },
        }],
      }],
    }])
  })
})
