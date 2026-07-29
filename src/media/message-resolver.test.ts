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
  jobQueue.enqueueAndWait = originalEnqueueAndWait
})

describe('resolveMessage', () => {
  test('does not enqueue missing descriptions while resolving a message', async () => {
    const calls: unknown[] = []

    prisma.media.findMany = (async () => {
      return [{ mediaId: 42, descriptionRaw: null }]
    }) as unknown as typeof prisma.media.findMany
    jobQueue.enqueueAndWait = (async (...args: unknown[]) => {
      calls.push(args)
    }) as typeof jobQueue.enqueueAndWait

    const resolved = await resolveMessage(makeMessage([{ type: 'video', referenceId: '42' }]))

    assert.deepEqual(calls, [])
    assert.deepEqual(resolved, [{ type: 'video', referenceId: '42' }])
  })

  test('uses an already persisted description without scheduling background work', async () => {
    const calls: unknown[] = []

    prisma.media.findMany = (async () => {
      return [{ mediaId: 42, descriptionRaw: { description: '已有描述', summary: '摘要' } }]
    }) as unknown as typeof prisma.media.findMany
    jobQueue.enqueueAndWait = (async (...args: unknown[]) => {
      calls.push(args)
    }) as typeof jobQueue.enqueueAndWait

    const resolved = await resolveMessage(makeMessage([{ type: 'image', referenceId: '42' }]))

    assert.deepEqual(calls, [])
    assert.deepEqual(resolved, [{
      type: 'image',
      referenceId: '42',
      mediaDescription: { description: '已有描述', summary: '摘要' },
    }])
  })

  test('resolves persisted descriptions for media nested inside forwarded messages', async () => {
    prisma.media.findMany = (async () => {
      return [{ mediaId: 42, descriptionRaw: { description: '转发图片描述' } }]
    }) as unknown as typeof prisma.media.findMany

    const resolved = await resolveMessage(makeMessage([{
      type: 'forward',
      forwardId: 'forward-1',
      items: [{
        senderId: '101',
        content: [{ type: 'image', referenceId: '42' }],
      }],
    }]))

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
