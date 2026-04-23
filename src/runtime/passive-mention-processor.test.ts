import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createPassiveMentionProcessor } from './passive-mention-processor.js'
import type { GroupConversationBatch, MentionEvent } from '../conversation/types.js'
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

function fakeSender() {
  const sent: Array<{ replyToMessageId: number; mentionUserId?: number; text: string }> = []
  return {
    sent,
    sender: {
      replyToMessage: async (params: { groupId: number; replyToMessageId: number; mentionUserId?: number; text: string }) => {
        sent.push(params)
        return { success: true, attempts: 1 }
      },
      sendMessage: async () => ({ success: true, attempts: 1 }),
    },
  }
}

function fakeAssistantTurnStore(status: 'pending' | 'sent' | null = null, text = 'reply') {
  let nextId = 1
  return {
    findByReplyIntentId: async () =>
      status === 'pending' || status === 'sent'
        ? { id: nextId, groupId: 1, senderThreadKey: 'sender:0', replyIntentId: 'intent', triggerMessageRowId: 1, incorporatedMessageRowId: 1, sequence: 1, replyToMessageId: 1, mentionUserId: undefined, text, status, attemptCount: 0, createdAt: new Date(0), updatedAt: new Date(0) }
        : null,
    createOrReusePending: async (input: {
      triggerMessageRowId: number
      incorporatedMessageRowId: number
      replyToMessageId: number
      mentionUserId?: number
      text: string
    }) => ({
      id: nextId++,
      groupId: 1,
      senderThreadKey: 'sender:0',
      replyIntentId: 'intent',
      triggerMessageRowId: input.triggerMessageRowId,
      incorporatedMessageRowId: input.incorporatedMessageRowId,
      sequence: 1,
      replyToMessageId: input.replyToMessageId,
      mentionUserId: input.mentionUserId,
      text: status === 'pending' || status === 'sent' ? text : input.text,
      status: status ?? 'pending',
      attemptCount: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }),
    markSending: async () => {},
    markSent: async () => {},
    markFailed: async () => {},
  }
}

function fakeConversationStateStore() {
  return {
    updateLastIncorporated: async () => {},
  }
}

function fakeCompactor() {
  return async () => {}
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
    resolvedText: text,
    sentAt: null,
    createdAt: new Date(0),
  }
}

describe('passive mention processor', () => {
  test('generates one reply for a simple single-user batch', async () => {
    const event = makeEvent({ messageId: 10, senderId: 20, createdAt: 1 })
    const { sent, sender } = fakeSender()

    const processor = createPassiveMentionProcessor({
      getMessage: async () => makeStoredMessage(event, '@bot 你好'),
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async () => '你好',
      sender,
      assistantTurnStore: fakeAssistantTurnStore(),
      conversationStateStore: fakeConversationStateStore(),
      compactor: fakeCompactor(),
    })

    const result = await processor.run(makeBatch([event]))

    assert.deepEqual(sent, [{ groupId: 1, replyToMessageId: 10, mentionUserId: 20, text: '你好' }])
    assert.deepEqual(result.leftoverEvents, [])
  })

  test('groups same-sender events, handles first two sender threads, and returns leftovers', async () => {
    const first = makeEvent({ messageId: 10, senderId: 20, createdAt: 1 })
    const second = makeEvent({ messageId: 11, senderId: 30, createdAt: 2 })
    const third = makeEvent({ messageId: 12, senderId: 40, createdAt: 3 })
    const fourth = makeEvent({ messageId: 15, senderId: 20, createdAt: 4 })
    const { sent, sender } = fakeSender()
    const generatedFor: number[] = []

    const messages = new Map<number, FakeStoredMessage>([
      [10, makeStoredMessage(first, '@bot 第一个问题')],
      [11, makeStoredMessage(second, '@bot 第二个问题')],
      [12, makeStoredMessage(third, '@bot 第三个问题')],
      [15, makeStoredMessage(fourth, '@bot 第一个人的补充')],
    ])

    const processor = createPassiveMentionProcessor({
      getMessage: async (_groupId, messageId) => messages.get(messageId) ?? null,
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async (message) => {
        generatedFor.push(message.messageId)
        return `reply:${message.messageId}`
      },
      sender,
      assistantTurnStore: fakeAssistantTurnStore(),
      conversationStateStore: fakeConversationStateStore(),
      compactor: fakeCompactor(),
    })

    const result = await processor.run(makeBatch([first, second, third, fourth]))

    assert.deepEqual(generatedFor, [15, 11])
    assert.deepEqual(sent, [
      { groupId: 1, replyToMessageId: 10, mentionUserId: 20, text: 'reply:15' },
      { groupId: 1, replyToMessageId: 11, mentionUserId: 30, text: 'reply:11' },
    ])
    assert.deepEqual(result.leftoverEvents, [third])
  })

  test('uses batch order when same-sender events share the same timestamp', async () => {
    const first = makeEvent({ messageId: 21, senderId: 20, createdAt: 1000 })
    const second = makeEvent({ messageId: 22, senderId: 20, createdAt: 1000 })
    const { sent, sender } = fakeSender()
    const generatedFor: number[] = []

    const messages = new Map<number, FakeStoredMessage>([
      [21, makeStoredMessage(first, '@bot 第一条')],
      [22, makeStoredMessage(second, '@bot 第二条补充')],
    ])

    const processor = createPassiveMentionProcessor({
      getMessage: async (_groupId, messageId) => messages.get(messageId) ?? null,
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async (message) => {
        generatedFor.push(message.messageId)
        return `reply:${message.messageId}`
      },
      sender,
      assistantTurnStore: fakeAssistantTurnStore(),
      conversationStateStore: fakeConversationStateStore(),
      compactor: fakeCompactor(),
    })

    await processor.run(makeBatch([first, second]))

    assert.deepEqual(generatedFor, [22])
    assert.deepEqual(sent, [
      { groupId: 1, replyToMessageId: 21, mentionUserId: 20, text: 'reply:22' },
    ])
  })

  test('does not send duplicate reply when assistant turn is already sent', async () => {
    const event = makeEvent({ messageId: 31, senderId: 20, createdAt: 1 })
    const { sent, sender } = fakeSender()

    const processor = createPassiveMentionProcessor({
      getMessage: async () => makeStoredMessage(event, '@bot 你好'),
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async () => '你好',
      sender,
      assistantTurnStore: fakeAssistantTurnStore('sent'),
      conversationStateStore: fakeConversationStateStore(),
      compactor: fakeCompactor(),
    })

    const result = await processor.run(makeBatch([event]))

    assert.deepEqual(sent, [])
    assert.deepEqual(result.leftoverEvents, [])
  })

  test('reuses stored assistant turn text when reply intent already exists', async () => {
    const event = makeEvent({ messageId: 41, senderId: 20, createdAt: 1 })
    const { sent, sender } = fakeSender()
    let generateReplyCalls = 0

    const processor = createPassiveMentionProcessor({
      getMessage: async () => makeStoredMessage(event, '@bot 你好'),
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async () => {
        generateReplyCalls++
        return '新生成文本'
      },
      sender,
      assistantTurnStore: fakeAssistantTurnStore('pending', '已存文本'),
      conversationStateStore: fakeConversationStateStore(),
      compactor: fakeCompactor(),
    })

    await processor.run(makeBatch([event]))

    assert.equal(generateReplyCalls, 0)
    assert.deepEqual(sent, [{ groupId: 1, replyToMessageId: 41, mentionUserId: 20, text: '已存文本' }])
  })

  test('notifies when assistant turn is sent', async () => {
    const event = makeEvent({ messageId: 51, senderId: 20, createdAt: 1 })
    const { sender } = fakeSender()
    const deliveredTurns: number[] = []

    const processor = createPassiveMentionProcessor({
      getMessage: async () => makeStoredMessage(event, '@bot 你好'),
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async () => '你好',
      sender,
      assistantTurnStore: fakeAssistantTurnStore(),
      conversationStateStore: fakeConversationStateStore(),
      compactor: fakeCompactor(),
      onAssistantTurnSent: async (turn) => {
        deliveredTurns.push(turn.incorporatedMessageRowId)
      },
    })

    await processor.run(makeBatch([event]))

    assert.deepEqual(deliveredTurns, [51])
  })
})
