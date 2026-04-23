import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { recoverConversationStartupState } from './recovery.js'

describe('conversation recovery', () => {
  test('startup recovery replays recoverable assistant turns only', async () => {
    const delivered: Array<{ replyToMessageId: number; mentionUserId?: number; text: string }> = []
    const turnMutations: Array<string> = []
    const recoveredTurnIds: number[] = []
    const requestedRecoverableGroups: Array<number[] | undefined> = []

    const result = await recoverConversationStartupState({
      groupIds: [1],
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
              providerMessageId: undefined,
              text: '恢复发送的回复',
              status: 'pending',
              attemptCount: 0,
              createdAt: new Date('2026-04-21T00:00:00Z'),
              updatedAt: new Date('2026-04-21T00:00:00Z'),
            },
          ]
        },
        markAcked: async (id, providerMessageId) => {
          turnMutations.push(`acked:${id}:${providerMessageId}`)
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
      compactor: async () => {},
      onAssistantTurnRecovered: async (turn) => {
        recoveredTurnIds.push(turn.id)
      },
    })

    assert.deepEqual(delivered, [
      { groupId: 1, replyToMessageId: 2001, mentionUserId: 20, text: '恢复发送的回复' },
    ])
    assert.deepEqual(requestedRecoverableGroups, [[1]])
    assert.deepEqual(turnMutations, ['sending:7', 'sent:7'])
    assert.deepEqual(recoveredTurnIds, [7])
    assert.deepEqual(result, {
      recoveredAssistantTurns: 1,
      failedAssistantTurns: 0,
      enqueuedMentions: 0,
    })
  })

  test('startup recovery marks failed assistant turns when resend fails', async () => {
    const turnMutations: Array<string> = []

    const result = await recoverConversationStartupState({
      groupIds: [1],
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
              providerMessageId: undefined,
              text: '会失败的回复',
            status: 'failed',
            attemptCount: 1,
            createdAt: new Date('2026-04-21T00:00:00Z'),
            updatedAt: new Date('2026-04-21T00:00:00Z'),
          },
        ],
        markAcked: async (id, providerMessageId) => {
          turnMutations.push(`acked:${id}:${providerMessageId}`)
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
      compactor: async () => {},
    })

    assert.deepEqual(turnMutations, ['sending:9', 'failed:9'])
    assert.deepEqual(result, {
      recoveredAssistantTurns: 0,
      failedAssistantTurns: 1,
      enqueuedMentions: 0,
    })
  })

  test('startup recovery leaves reply dry-run turns recoverable', async () => {
    const turnMutations: Array<string> = []
    const recoveredTurnIds: number[] = []
    let replyCalls = 0

    const result = await recoverConversationStartupState({
      groupIds: [1],
      sender: {
        isReplyDryRunEnabled() {
          return true
        },
        async replyToMessage() {
          replyCalls++
          return { success: true, attempts: 1 }
        },
        async sendMessage() {
          return { success: true, attempts: 1 }
        },
      },
      assistantTurnStore: {
        listRecoverable: async () => [
          {
            id: 10,
            groupId: 1,
            senderThreadKey: 'sender:20',
            replyIntentId: 'intent-3',
            triggerMessageRowId: 12,
            incorporatedMessageRowId: 12,
              sequence: 3,
              replyToMessageId: 4001,
              mentionUserId: 20,
              providerMessageId: undefined,
              text: '不会真的发出去',
            status: 'pending',
            attemptCount: 0,
            createdAt: new Date('2026-04-21T00:00:00Z'),
            updatedAt: new Date('2026-04-21T00:00:00Z'),
          },
        ],
        markAcked: async (id, providerMessageId) => {
          turnMutations.push(`acked:${id}:${providerMessageId}`)
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
      compactor: async () => {},
      onAssistantTurnRecovered: async (turn) => {
        recoveredTurnIds.push(turn.id)
      },
    })

    assert.equal(replyCalls, 0)
    assert.deepEqual(turnMutations, [])
    assert.deepEqual(recoveredTurnIds, [])
    assert.deepEqual(result, {
      recoveredAssistantTurns: 0,
      failedAssistantTurns: 0,
      enqueuedMentions: 0,
    })
  })

  test('startup recovery finalizes acked assistant turns without re-sending', async () => {
    const turnMutations: Array<string> = []
    let replyCalls = 0

    const result = await recoverConversationStartupState({
      groupIds: [1],
      sender: {
        async replyToMessage() {
          replyCalls++
          return { success: true, attempts: 1 }
        },
        async sendMessage() {
          return { success: true, attempts: 1 }
        },
      },
      assistantTurnStore: {
        listRecoverable: async () => [
          {
            id: 11,
            groupId: 1,
            senderThreadKey: 'sender:20',
            replyIntentId: 'intent-4',
            triggerMessageRowId: 15,
            incorporatedMessageRowId: 15,
            sequence: 4,
            replyToMessageId: 5001,
            mentionUserId: 20,
            providerMessageId: 9003,
            text: '已经 ack 的回复',
            status: 'acked',
            attemptCount: 1,
            createdAt: new Date('2026-04-21T00:00:00Z'),
            updatedAt: new Date('2026-04-21T00:00:00Z'),
          },
        ],
        markAcked: async (id, providerMessageId) => {
          turnMutations.push(`acked:${id}:${providerMessageId}`)
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
      compactor: async () => {},
    })

    assert.equal(replyCalls, 0)
    assert.deepEqual(turnMutations, ['sent:11'])
    assert.deepEqual(result, {
      recoveredAssistantTurns: 1,
      failedAssistantTurns: 0,
      enqueuedMentions: 0,
    })
  })
})
