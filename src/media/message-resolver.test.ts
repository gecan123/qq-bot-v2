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
    rowId: 1,
    eventKind: 'message',
    eventExternalId: 'message:100',
    platform: 'qq',
    accountId: '10000',
    conversationKind: 'group',
    conversationExternalId: '1',
    conversationName: '测试群',
    mediaReferenceIds: ['42'],
    messageExternalId: '100',
    replyToExternalId: null,
    rootExternalId: null,
    threadExternalId: null,
    senderExternalId: '200',
    senderName: '测试用户',
    senderConversationName: null,
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
