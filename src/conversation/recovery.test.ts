import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Message } from '../generated/prisma/client.js'
import { recoverConversationStartupState } from './recovery.js'

function makeMessage(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    id: overrides.id,
    groupId: overrides.groupId ?? BigInt(1),
    groupName: overrides.groupName ?? '测试群',
    mediaReferenceIds: overrides.mediaReferenceIds ?? [],
    messageId: overrides.messageId ?? BigInt(overrides.id),
    senderId: overrides.senderId ?? BigInt(20),
    senderNickname: overrides.senderNickname ?? '用户20',
    senderGroupNickname: overrides.senderGroupNickname ?? null,
    content: overrides.content ?? [],
    rawContent: overrides.rawContent ?? null,
    rawMessage: overrides.rawMessage ?? null,
    searchText: overrides.searchText ?? '',
    resolvedText: overrides.resolvedText ?? null,
    sentAt: overrides.sentAt ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-04-21T00:00:00Z'),
  }
}

describe('conversation recovery', () => {
  test('startup recovery replays recoverable assistant turns and re-enqueues later mentions', async () => {
    const delivered: Array<{ replyToMessageId: number; mentionUserId?: number; text: string }> = []
    const queueEvents: Array<{ groupId: number; messageId: number; senderId: number; createdAt: number }> = []
    const stateByKey = new Map<string, number | undefined>([['1:sender:20', 4]])
    const turnMutations: Array<string> = []
    const requestedRecoverableGroups: Array<number[] | undefined> = []

    const result = await recoverConversationStartupState({
      groupIds: [1],
      selfNumber: 999,
      queue: {
        enqueueMention(event) {
          queueEvents.push(event)
        },
        start() {},
        stop() {},
      },
      sender: {
        async replyToMessage(params) {
          delivered.push(params)
          return { success: true, attempts: 1 }
        },
        async sendMessage() {
          return { success: true, attempts: 1 }
        },
      },
      assistantTurnStore: {
        listRecoverable: async (groupIds?: number[]) => {
          requestedRecoverableGroups.push(groupIds)
          return [
            {
              id: 7,
              groupId: 1,
              senderThreadKey: 'sender:20',
              replyIntentId: 'intent-1',
              triggerMessageRowId: 4,
              incorporatedMessageRowId: 5,
              sequence: 1,
              replyToMessageId: 2001,
              mentionUserId: 20,
              text: '恢复发送的回复',
              status: 'pending',
              attemptCount: 0,
              createdAt: new Date('2026-04-21T00:00:00Z'),
              updatedAt: new Date('2026-04-21T00:00:00Z'),
            },
          ]
        },
        markSending: async (id) => {
          turnMutations.push(`sending:${id}`)
        },
        markSent: async (id) => {
          turnMutations.push(`sent:${id}`)
        },
        markFailed: async (id) => {
          turnMutations.push(`failed:${id}`)
        },
      },
      conversationStateStore: {
        listByGroupIds: async () => [
          {
            id: 1,
            groupId: 1,
            senderThreadKey: 'sender:20',
            compactedBase: '',
            compactedVersion: 1,
            lastCompactedMessageRowId: undefined,
            lastIncorporatedMessageRowId: stateByKey.get('1:sender:20'),
            createdAt: new Date('2026-04-21T00:00:00Z'),
            updatedAt: new Date('2026-04-21T00:00:00Z'),
          },
        ],
        updateLastIncorporated: async (groupId, senderThreadKey, messageRowId) => {
          stateByKey.set(`${groupId}:${senderThreadKey}`, messageRowId)
        },
      },
      messageStore: {
        listAfterRowId: async (_groupId, afterRowId) => {
          assert.equal(afterRowId, 5)
          return [
            makeMessage({
              id: 6,
              messageId: BigInt(2002),
              senderId: BigInt(20),
              content: [{ type: 'at', targetId: '999' }],
            }),
            makeMessage({
              id: 7,
              messageId: BigInt(2003),
              senderId: BigInt(20),
              content: [{ type: 'text', content: '普通补充' }],
            }),
            makeMessage({
              id: 8,
              messageId: BigInt(2004),
              senderId: BigInt(30),
              content: [{ type: 'at', targetId: '999' }],
            }),
          ]
        },
      },
      compactor: async () => {},
    })

    assert.deepEqual(delivered, [
      { groupId: 1, replyToMessageId: 2001, mentionUserId: 20, text: '恢复发送的回复' },
    ])
    assert.deepEqual(requestedRecoverableGroups, [[1]])
    assert.deepEqual(turnMutations, ['sending:7', 'sent:7'])
    assert.deepEqual(queueEvents, [
      {
        groupId: 1,
        messageId: 2002,
        senderId: 20,
        createdAt: makeMessage({ id: 6 }).createdAt.getTime(),
      },
    ])
    assert.deepEqual(result, {
      recoveredAssistantTurns: 1,
      failedAssistantTurns: 0,
      enqueuedMentions: 1,
    })
  })

  test('startup recovery marks failed assistant turns when resend fails', async () => {
    const turnMutations: Array<string> = []

    const result = await recoverConversationStartupState({
      groupIds: [1],
      selfNumber: 999,
      queue: {
        enqueueMention() {},
        start() {},
        stop() {},
      },
      sender: {
        async replyToMessage() {
          return { success: false, attempts: 1 }
        },
        async sendMessage() {
          return { success: true, attempts: 1 }
        },
      },
      assistantTurnStore: {
        listRecoverable: async () => [
          {
            id: 9,
            groupId: 1,
            senderThreadKey: 'sender:20',
            replyIntentId: 'intent-2',
            triggerMessageRowId: 9,
            incorporatedMessageRowId: 9,
            sequence: 2,
            replyToMessageId: 3001,
            mentionUserId: 20,
            text: '会失败的回复',
            status: 'failed',
            attemptCount: 1,
            createdAt: new Date('2026-04-21T00:00:00Z'),
            updatedAt: new Date('2026-04-21T00:00:00Z'),
          },
        ],
        markSending: async (id) => {
          turnMutations.push(`sending:${id}`)
        },
        markSent: async (id) => {
          turnMutations.push(`sent:${id}`)
        },
        markFailed: async (id) => {
          turnMutations.push(`failed:${id}`)
        },
      },
      conversationStateStore: {
        listByGroupIds: async () => [],
        updateLastIncorporated: async () => {},
      },
      messageStore: {
        listAfterRowId: async () => [],
      },
      compactor: async () => {},
    })

    assert.deepEqual(turnMutations, ['sending:9', 'failed:9'])
    assert.deepEqual(result, {
      recoveredAssistantTurns: 0,
      failedAssistantTurns: 1,
      enqueuedMentions: 0,
    })
  })
})
