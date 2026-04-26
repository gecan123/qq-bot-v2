import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createPassiveMentionProcessor } from './passive-mention-processor.js'
import type { ReplyExecutorOptions } from './reply-executor.js'
import type { ActionDeliveryState } from './action-record-store.js'
import type { GroupConversationBatch, MentionEvent } from '../conversation/types.js'
import type { ParsedSegment } from '../types/message-segments.js'
import type { Message } from '../generated/prisma/client.js'
import type { CreateOrReuseReplyRecordInput } from '../conversation/reply-record-store.js'

type FakeStoredMessage = Message

function makeEvent(overrides: Partial<MentionEvent> = {}): MentionEvent {
  return {
    groupId: overrides.groupId ?? 1,
    messageId: overrides.messageId ?? 10,
    senderId: overrides.senderId ?? 20,
    createdAt: overrides.createdAt ?? Date.now(),
    runtimeOpportunityId: overrides.runtimeOpportunityId,
    runtimeDecisionId: overrides.runtimeDecisionId,
    runtimeSceneId: overrides.runtimeSceneId,
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

function fakeReplyRecordStore(status: 'pending' | 'sent' | 'dry_run' | null = null, text = 'reply') {
  let nextId = 1
  return {
    findByReplyIntentId: async () =>
      status === 'pending' || status === 'sent' || status === 'dry_run'
        ? {
            id: nextId,
            runtimeKey: 'qq_group:1',
            groupId: 1,
            scopeKey: 'sender:20',
            replyIntentId: 'intent',
            sourceKind: 'mention',
            triggerMessageRowId: 1,
            incorporatedMessageRowId: 1,
            deliveryPayload: { type: 'reply_to_message' as const, replyToMessageId: 1 },
            text,
            executionState: status,
            providerMessageId: undefined,
            attemptCount: 0,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          }
        : null,
    createOrReuse: async (input: CreateOrReuseReplyRecordInput) => ({
      id: nextId++,
      runtimeKey: input.runtimeKey,
      groupId: 1,
      scopeKey: input.scopeKey,
      replyIntentId: input.replyIntentId,
      sourceKind: input.sourceKind,
      triggerMessageRowId: input.triggerMessageRowId,
      incorporatedMessageRowId: input.incorporatedMessageRowId,
      deliveryPayload: input.deliveryPayload,
      text: status === 'pending' || status === 'sent' || status === 'dry_run' ? text : input.text,
      executionState: status ?? input.executionState,
      providerMessageId: undefined,
      attemptCount: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }),
    markAcked: async () => {},
    markSending: async () => {},
    markSent: async () => {},
    markFailed: async () => {},
  }
}

function fakeActionRecordStore(status: 'pending' | 'sent' | 'dry_run' | null = null, text?: string): NonNullable<ReplyExecutorOptions['actionRecordStore']> {
  return {
    createOrReuseIntent: async (input: {
      id: string
      opportunityId: string
      actionType: string
      targetSceneId: string
      payload: Record<string, unknown>
      dryRun: boolean
      riskLevel?: string
      status?: string
      idempotencyKey: string
    }) => ({
      id: input.id,
      opportunityId: input.opportunityId,
      actionType: input.actionType,
      targetSceneId: input.targetSceneId,
      payload: input.payload,
      dryRun: input.dryRun,
      riskLevel: input.riskLevel ?? 'low',
      status: input.status ?? 'pending',
      idempotencyKey: input.idempotencyKey,
    }),
    createOrReuseRecord: async (input: {
      id: string
      actionIntentId: string
      actionType: string
      targetSceneId: string
      deliveryState: ActionDeliveryState
      idempotencyKey: string
      resultPayload?: Record<string, unknown> | null
    }) => ({
      id: input.id,
      actionIntentId: input.actionIntentId,
      actionType: input.actionType,
      targetSceneId: input.targetSceneId,
      deliveryState: status ?? input.deliveryState,
      idempotencyKey: input.idempotencyKey,
      resultPayload: text && input.resultPayload ? { ...input.resultPayload, text } : input.resultPayload ?? null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }),
    markDeliveryState: async (id: string, deliveryState: ActionDeliveryState, resultPayload?: Record<string, unknown> | null) => ({
      id,
      actionIntentId: 'intent',
      actionType: 'send_group_reply',
      targetSceneId: 'qq_group:1',
      deliveryState,
      idempotencyKey: 'intent',
      resultPayload: resultPayload ?? null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }),
  }
}

function capturingActionRecordStore(
  intents: Array<{ opportunityId: string; decisionId?: string | null; targetSceneId: string }>,
): NonNullable<ReplyExecutorOptions['actionRecordStore']> {
  return {
    ...fakeActionRecordStore(),
    createOrReuseIntent: async (input) => {
      intents.push({
        opportunityId: input.opportunityId,
        decisionId: input.decisionId,
        targetSceneId: input.targetSceneId,
      })
      return {
        id: input.id,
        opportunityId: input.opportunityId,
        decisionId: input.decisionId,
        actionType: input.actionType,
        targetSceneId: input.targetSceneId,
        payload: input.payload,
        dryRun: input.dryRun,
        riskLevel: input.riskLevel ?? 'L3',
        status: input.status ?? 'approved',
        idempotencyKey: input.idempotencyKey,
      }
    },
  }
}

function fakeCompactor() {
  return async () => {}
}

function makeStoredMessage(event: MentionEvent, text: string): FakeStoredMessage {
  return {
    id: event.messageId,
    sceneKind: 'qq_group',
    sceneExternalId: String(event.groupId),
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
      replyRecordStore: fakeReplyRecordStore(),
      actionRecordStore: fakeActionRecordStore(),
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
      replyRecordStore: fakeReplyRecordStore(),
      actionRecordStore: fakeActionRecordStore(),
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
      replyRecordStore: fakeReplyRecordStore(),
      actionRecordStore: fakeActionRecordStore(),
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
    const deliveredTurns: number[] = []

    const processor = createPassiveMentionProcessor({
      getMessage: async () => makeStoredMessage(event, '@bot 你好'),
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async () => '你好',
      sender,
      replyRecordStore: fakeReplyRecordStore('sent'),
      actionRecordStore: fakeActionRecordStore('sent'),
      compactor: fakeCompactor(),
      onReplyRecordSent: async (record) => {
        deliveredTurns.push(record.incorporatedMessageRowId ?? 0)
      },
    })

    const result = await processor.run(makeBatch([event]))

    assert.deepEqual(sent, [])
    assert.deepEqual(deliveredTurns, [31])
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
      replyRecordStore: fakeReplyRecordStore('pending', '已存文本'),
      actionRecordStore: fakeActionRecordStore('pending', '已存文本'),
      compactor: fakeCompactor(),
    })

    await processor.run(makeBatch([event]))

    assert.equal(generateReplyCalls, 0)
    assert.deepEqual(sent, [{ groupId: 1, replyToMessageId: 41, mentionUserId: 20, text: '已存文本' }])
  })

  test('does not reuse removed qq_group root legacy reply intent bridge', async () => {
    const first = makeEvent({ messageId: 71, senderId: 20, createdAt: 1 })
    const second = makeEvent({ messageId: 72, senderId: 20, createdAt: 2 })
    const { sent, sender } = fakeSender()
    let generateReplyCalls = 0

    const messages = new Map<number, FakeStoredMessage>([
      [71, makeStoredMessage(first, '@bot 第一条')],
      [72, makeStoredMessage(second, '@bot 第二条补充')],
    ])

    const processor = createPassiveMentionProcessor({
      getMessage: async (_groupId, messageId) => messages.get(messageId) ?? null,
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async () => {
        generateReplyCalls++
        return '新生成文本'
      },
      sender,
      replyRecordStore: {
        ...fakeReplyRecordStore(),
        findByReplyIntentId: async (_runtimeKey, replyIntentId) => {
          if (replyIntentId !== 'qq_group:1:sender:20:71:72') {
            return null
          }

          return {
            id: 1,
            runtimeKey: 'qq_group:1',
            groupId: 1,
            scopeKey: 'sender:20',
            replyIntentId,
            sourceKind: 'mention',
            triggerMessageRowId: 71,
            incorporatedMessageRowId: 72,
            deliveryPayload: { type: 'reply_to_message' as const, replyToMessageId: 71, mentionUserId: 20 },
            text: '旧格式已存文本',
            executionState: 'pending' as const,
            providerMessageId: undefined,
            attemptCount: 0,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          }
        },
      },
      actionRecordStore: fakeActionRecordStore(),
      compactor: fakeCompactor(),
    })

    await processor.run(makeBatch([first, second]))

    assert.equal(generateReplyCalls, 1)
    assert.deepEqual(sent, [{ groupId: 1, replyToMessageId: 71, mentionUserId: 20, text: '新生成文本' }])
  })

  test('derives stable reply intent id from the anchored mention cue', async () => {
    const first = makeEvent({ messageId: 61, senderId: 20, createdAt: 1 })
    const second = makeEvent({ messageId: 62, senderId: 20, createdAt: 2 })
    const { sender } = fakeSender()
    const replyIntentIds: string[] = []

    const messages = new Map<number, FakeStoredMessage>([
      [61, makeStoredMessage(first, '@bot 第一条')],
      [62, makeStoredMessage(second, '@bot 第二条补充')],
    ])

    const processor = createPassiveMentionProcessor({
      getMessage: async (_groupId, messageId) => messages.get(messageId) ?? null,
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async () => 'reply:62',
      sender,
      replyRecordStore: {
        ...fakeReplyRecordStore(),
        createOrReuse: async (input) => {
          replyIntentIds.push(input.replyIntentId)
          return {
            id: 1,
            runtimeKey: input.runtimeKey,
            groupId: 1,
            scopeKey: input.scopeKey,
            replyIntentId: input.replyIntentId,
            sourceKind: input.sourceKind,
            triggerMessageRowId: input.triggerMessageRowId,
            incorporatedMessageRowId: input.incorporatedMessageRowId,
            deliveryPayload: input.deliveryPayload,
            text: input.text,
            executionState: input.executionState,
            providerMessageId: undefined,
            attemptCount: 0,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          }
        },
      },
      actionRecordStore: fakeActionRecordStore(),
      compactor: fakeCompactor(),
    })

    await processor.run(makeBatch([first, second]))

    assert.deepEqual(replyIntentIds, ['qq_group:1:message:61:reply_to_message'])
  })

  test('threads root runtime opportunity and decision ids into action intents', async () => {
    const event = makeEvent({
      messageId: 81,
      senderId: 20,
      createdAt: 1,
      runtimeOpportunityId: 'opportunity-root-81',
      runtimeDecisionId: 'decision-root-81',
      runtimeSceneId: 'qq_group:1',
    })
    const { sender } = fakeSender()
    const intents: Array<{ opportunityId: string; decisionId?: string | null; targetSceneId: string }> = []

    const processor = createPassiveMentionProcessor({
      getMessage: async () => makeStoredMessage(event, '@bot 你好'),
      resolveSegments: async (message): Promise<ParsedSegment[]> => message.content as unknown as ParsedSegment[],
      generateReply: async () => '你好',
      sender,
      replyRecordStore: fakeReplyRecordStore(),
      actionRecordStore: capturingActionRecordStore(intents),
      compactor: fakeCompactor(),
    })

    await processor.run(makeBatch([event]))

    assert.deepEqual(intents, [{
      opportunityId: 'opportunity-root-81',
      decisionId: 'decision-root-81',
      targetSceneId: 'qq_group:1',
    }])
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
      replyRecordStore: fakeReplyRecordStore(),
      actionRecordStore: fakeActionRecordStore(),
      compactor: fakeCompactor(),
      onReplyRecordSent: async (record) => {
        deliveredTurns.push(record.incorporatedMessageRowId ?? 0)
      },
    })

    await processor.run(makeBatch([event]))

    assert.deepEqual(deliveredTurns, [51])
  })
})
