import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { migrateLegacyAssistantTurnsToReplyRecords } from './reply-record-migration.js'
import type { AssistantTurnRecord } from './assistant-turn-store.js'

function makeTurn(overrides: Partial<AssistantTurnRecord> = {}): AssistantTurnRecord {
  return {
    id: overrides.id ?? 1,
    groupId: overrides.groupId ?? 1,
    senderThreadKey: overrides.senderThreadKey ?? 'sender:20',
    replyIntentId: overrides.replyIntentId ?? 'qq_group:1:sender:20:11:12',
    triggerMessageRowId: overrides.triggerMessageRowId ?? 11,
    incorporatedMessageRowId: overrides.incorporatedMessageRowId ?? 12,
    sequence: overrides.sequence ?? 1,
    replyToMessageId: overrides.replyToMessageId ?? 1001,
    mentionUserId: overrides.mentionUserId ?? 20,
    providerMessageId: overrides.providerMessageId,
    text: overrides.text ?? '已回复',
    status: overrides.status ?? 'sent',
    attemptCount: overrides.attemptCount ?? 1,
    createdAt: overrides.createdAt ?? new Date('2026-04-22T00:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-04-22T00:00:00Z'),
  }
}

describe('migrateLegacyAssistantTurnsToReplyRecords', () => {
  test('migrates legacy mention turns using normalized cue-based reply intent id', async () => {
    const lookups: string[] = []
    const upserts: string[] = []

    const result = await migrateLegacyAssistantTurnsToReplyRecords({
      groupIds: [1],
      listLegacyAssistantTurnsFn: async () => [makeTurn()],
      findReplyRecordByReplyIntentIdFn: async (_runtimeKey, replyIntentId) => {
        lookups.push(replyIntentId)
        return null
      },
      upsertReplyRecordFromLegacyAssistantTurnFn: async (turn) => {
        upserts.push(turn.replyIntentId)
        return {
          id: 1,
          runtimeKey: 'qq_group:1',
          groupId: 1,
          scopeKey: 'sender:20',
          replyIntentId: 'qq_group:1:message:11:reply_to_message',
          sourceKind: 'mention',
          triggerMessageRowId: 11,
          incorporatedMessageRowId: 12,
          deliveryPayload: { type: 'reply_to_message', replyToMessageId: 1001, mentionUserId: 20 },
          text: '已回复',
          executionState: 'sent',
          providerMessageId: undefined,
          attemptCount: 1,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }
      },
      rootRuntime: {
        async restore() {
          return { restoredCount: 0 }
        },
        async ingestGroupMessage() {},
        getSnapshot() {
          return null
        },
        async primeGroupCursor() {},
        requeuePendingPassiveMentions() {
          return 0
        },
        async markPassiveReplyDelivered() {},
        dispatchPassiveMentionIfMentioned() {
          return false
        },
        enqueuePassiveMention() {},
        startPassiveExecution() {},
        stopPassiveExecution() {},
      },
    })

    assert.deepEqual(lookups, ['qq_group:1:message:11:reply_to_message', 'qq_group:1:sender:20:11:12'])
    assert.deepEqual(upserts, ['qq_group:1:sender:20:11:12'])
    assert.equal(result.migratedCount, 1)
  })

  test('skips migration when a normalized or legacy reply record already exists', async () => {
    const upserts: string[] = []

    const result = await migrateLegacyAssistantTurnsToReplyRecords({
      groupIds: [1],
      listLegacyAssistantTurnsFn: async () => [makeTurn()],
      findReplyRecordByReplyIntentIdFn: async (_runtimeKey, replyIntentId) => {
        if (replyIntentId === 'qq_group:1:message:11:reply_to_message') {
          return {
            id: 1,
            runtimeKey: 'qq_group:1',
            groupId: 1,
            scopeKey: 'sender:20',
            replyIntentId,
            sourceKind: 'mention',
            triggerMessageRowId: 11,
            incorporatedMessageRowId: 12,
            deliveryPayload: { type: 'reply_to_message', replyToMessageId: 1001, mentionUserId: 20 },
            text: '已回复',
            executionState: 'sent',
            providerMessageId: undefined,
            attemptCount: 1,
            createdAt: new Date('2026-04-22T00:00:00Z'),
            updatedAt: new Date('2026-04-22T00:00:00Z'),
          }
        }

        return null
      },
      upsertReplyRecordFromLegacyAssistantTurnFn: async (turn) => {
        upserts.push(turn.replyIntentId)
        throw new Error('should not upsert when normalized record exists')
      },
    })

    assert.deepEqual(upserts, [])
    assert.equal(result.migratedCount, 0)
  })
})
