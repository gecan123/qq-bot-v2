import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from '../database/client.js'
import type { Message } from '../generated/prisma/client.js'
import { jobQueue } from '../queue/runtime.js'
import { resolveMessage } from './message-resolver.js'

const originalFindMany = prisma.media.findMany
const originalEnqueueAndWait = jobQueue.enqueueAndWait

function makeMessage(content: unknown): Message {
  return {
    id: 1,
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
  jobQueue.enqueueAndWait = originalEnqueueAndWait
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
      return [{ mediaId: 42, description: '视频描述' }]
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
    assert.deepEqual(resolved, [{ type: 'video', referenceId: '42', description: '视频描述' }])
  })
})
