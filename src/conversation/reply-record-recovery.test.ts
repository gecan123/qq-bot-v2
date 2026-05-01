import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { recoverReplyRecordStartupState } from './reply-record-recovery.js'
import type { ReplyRecord } from './reply-record-store.js'

function makeReplyRecord(overrides: Partial<ReplyRecord> = {}): ReplyRecord {
  return {
    id: overrides.id ?? 1,
    runtimeKey: overrides.runtimeKey ?? 'qq_group:1',
    groupId: overrides.groupId ?? 1,
    scopeKey: overrides.scopeKey ?? 'sender:20',
    replyIntentId: overrides.replyIntentId ?? 'intent-1',
    sourceKind: overrides.sourceKind ?? 'mention',
    triggerMessageRowId: overrides.triggerMessageRowId ?? 10,
    incorporatedMessageRowId: overrides.incorporatedMessageRowId ?? 10,
    deliveryPayload:
      overrides.deliveryPayload ?? { type: 'reply_to_message', replyToMessageId: 1001, mentionUserId: 20 },
    text: overrides.text ?? '你好',
    executionState: overrides.executionState ?? 'pending',
    providerMessageId: overrides.providerMessageId,
    attemptCount: overrides.attemptCount ?? 0,
    createdAt: overrides.createdAt ?? new Date('2026-04-23T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-04-23T00:00:00Z'),
  }
}

describe('reply record recovery', () => {
  test('startup recovery replays recoverable reply records only', async () => {
    const sent: string[] = []
    const recovered: number[] = []

    const result = await recoverReplyRecordStartupState({
      groupIds: [1],
      sender: {
        async replyToMessage() {
          sent.push('reply')
          return { success: true, attempts: 1 }
        },
      },
      replyRecordStore: {
        listRecoverable: async () => [
          makeReplyRecord({ id: 7, executionState: 'pending' }),
        ],
        markAcked: async () => {},
        markSending: async () => {},
        markSent: async () => {},
        markFailed: async () => {},
      },
      onReplyRecordRecovered: async (record) => {
        recovered.push(record.id)
      },
    })

    assert.deepEqual(sent, ['reply'])
    assert.deepEqual(recovered, [7])
    assert.deepEqual(result, {
      recoveredReplyRecords: 1,
      failedReplyRecords: 0,
    })
  })
})
