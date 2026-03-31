import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createConversationWorker } from './worker.js'
import type { GroupConversationBatch, MentionEvent } from './types.js'
import type { ParsedSegment } from '../types/message-segments.js'
import type { Message } from '../generated/prisma/client.js'

type FakeStoredMessage = Message

function makeEvent(overrides: Partial<MentionEvent> = {}): MentionEvent {
  return {
    groupId: overrides.groupId ?? 1,
    messageId: overrides.messageId ?? 10,
    senderId: overrides.senderId ?? 20,
    createdAt: overrides.createdAt ?? Date.now(),
  }
}

function makeBatch(events: MentionEvent[]): GroupConversationBatch {
  return {
    groupId: 1,
    events,
    openedAt: events[0]?.createdAt ?? Date.now(),
    closedAt: events[events.length - 1]?.createdAt ?? Date.now(),
  }
}

function makeStoredMessage(event: MentionEvent, text: string): FakeStoredMessage {
  return {
    id: event.messageId,
    groupId: BigInt(event.groupId),
    groupName: '测试群',
    mediaReferenceIds: [],
    messageId: BigInt(event.messageId),
    senderId: BigInt(event.senderId),
    senderNickname: `用户${event.senderId}`,
    senderGroupNickname: null,
    content: [{ type: 'text', content: text }] as unknown as FakeStoredMessage['content'],
    rawContent: null,
    rawMessage: null,
    searchText: text,
    sentAt: null,
    createdAt: new Date(0),
  }
}

describe('conversation worker', () => {
  test('worker generates one reply for a simple single-user batch', async () => {
    const event = makeEvent({ messageId: 10, senderId: 20, createdAt: 1 })
    const sent: Array<{ replyToMessageId: number; mentionUserId?: number; text: string }> = []

    const worker = createConversationWorker({
      getMessage: async () => makeStoredMessage(event, '@bot 你好'),
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async () => '你好',
      sender: {
        replyToMessage: async (params) => {
          sent.push(params)
        },
      },
    })

    const result = await worker.run(makeBatch([event]))

    assert.deepEqual(sent, [{ groupId: 1, replyToMessageId: 10, mentionUserId: 20, text: '你好' }])
    assert.deepEqual(result.leftoverEvents, [])
  })

  test('worker groups same-sender events, handles first two sender threads, and returns leftovers', async () => {
    const first = makeEvent({ messageId: 10, senderId: 20, createdAt: 1 })
    const second = makeEvent({ messageId: 11, senderId: 30, createdAt: 2 })
    const third = makeEvent({ messageId: 12, senderId: 40, createdAt: 3 })
    const fourth = makeEvent({ messageId: 15, senderId: 20, createdAt: 4 })
    const sent: Array<{ replyToMessageId: number; mentionUserId?: number; text: string }> = []
    const generatedFor: number[] = []

    const messages = new Map<number, FakeStoredMessage>([
      [10, makeStoredMessage(first, '@bot 第一个问题')],
      [11, makeStoredMessage(second, '@bot 第二个问题')],
      [12, makeStoredMessage(third, '@bot 第三个问题')],
      [15, makeStoredMessage(fourth, '@bot 第一个人的补充')],
    ])

    const worker = createConversationWorker({
      getMessage: async (_groupId, messageId) => messages.get(messageId) ?? null,
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async (message) => {
        generatedFor.push(message.messageId)
        return `reply:${message.messageId}`
      },
      sender: {
        replyToMessage: async (params) => {
          sent.push(params)
        },
      },
    })

    const result = await worker.run(makeBatch([first, second, third, fourth]))

    assert.deepEqual(generatedFor, [15, 11])
    assert.deepEqual(sent, [
      { groupId: 1, replyToMessageId: 10, mentionUserId: 20, text: 'reply:15' },
      { groupId: 1, replyToMessageId: 11, mentionUserId: 30, text: 'reply:11' },
    ])
    assert.deepEqual(result.leftoverEvents, [third])
  })

  test('worker uses batch order when same-sender events share the same timestamp', async () => {
    const first = makeEvent({ messageId: 21, senderId: 20, createdAt: 1000 })
    const second = makeEvent({ messageId: 22, senderId: 20, createdAt: 1000 })
    const sent: Array<{ replyToMessageId: number; mentionUserId?: number; text: string }> = []
    const generatedFor: number[] = []

    const messages = new Map<number, FakeStoredMessage>([
      [21, makeStoredMessage(first, '@bot 第一条')],
      [22, makeStoredMessage(second, '@bot 第二条补充')],
    ])

    const worker = createConversationWorker({
      getMessage: async (_groupId, messageId) => messages.get(messageId) ?? null,
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async (message) => {
        generatedFor.push(message.messageId)
        return `reply:${message.messageId}`
      },
      sender: {
        replyToMessage: async (params) => {
          sent.push(params)
        },
      },
    })

    await worker.run(makeBatch([first, second]))

    assert.deepEqual(generatedFor, [22])
    assert.deepEqual(sent, [
      { groupId: 1, replyToMessageId: 21, mentionUserId: 20, text: 'reply:22' },
    ])
  })
})
