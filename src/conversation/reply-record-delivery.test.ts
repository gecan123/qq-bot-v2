import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deliverReplyRecord } from './reply-record-delivery.js'
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

describe('reply record delivery', () => {
  test('creates audit and skips sending for reply_to_message dry-run record', async () => {
    const audits: string[] = []
    let replyCalls = 0

    const result = await deliverReplyRecord(makeReplyRecord({ executionState: 'dry_run' }), {
      sender: {
        isReplyDryRunEnabled: () => true,
        async replyToMessage() {
          replyCalls++
          return { success: true, attempts: 1 }
        },
        async sendMessage() {
          return { success: true, attempts: 1 }
        },
      },
      replyAuditStore: {
        create: async (input) => {
          audits.push(`${input.auditKind}:${input.replyIntentId}`)
        },
      },
    })

    assert.equal(result, 'dry_run')
    assert.equal(replyCalls, 0)
    assert.deepEqual(audits, [])
  })

  test('persists provider ack before marking reply record sent', async () => {
    const mutations: string[] = []

    const result = await deliverReplyRecord(makeReplyRecord(), {
      sender: {
        async replyToMessage() {
          return { success: true, attempts: 1, providerMessageId: 9001 }
        },
        async sendMessage() {
          return { success: true, attempts: 1 }
        },
      },
      replyRecordStore: {
        markAcked: async (id, providerMessageId) => {
          mutations.push(`acked:${id}:${providerMessageId}`)
        },
        markSending: async (id) => {
          mutations.push(`sending:${id}`)
        },
        markSent: async (id) => {
          mutations.push(`sent:${id}`)
        },
        markFailed: async (id) => {
          mutations.push(`failed:${id}`)
        },
      },
    })

    assert.equal(result, 'sent')
    assert.deepEqual(mutations, ['sending:1', 'acked:1:9001', 'sent:1'])
  })

  test('dispatches send_private_message payload through private adapter', async () => {
    const calls: string[] = []

    const result = await deliverReplyRecord(
      makeReplyRecord({
        id: 3,
        groupId: 20,
        scopeKey: 'qq_private:20',
        sourceKind: 'private_message',
        deliveryPayload: { type: 'send_private_message', userId: 20 },
        text: '私聊恢复',
      }),
      {
        sender: {
          isReplyDryRunEnabled: () => false,
          async replyToMessage() {
            calls.push('reply')
            return { success: true, attempts: 1 }
          },
          async sendMessage() {
            calls.push('send')
            return { success: true, attempts: 1 }
          },
          async sendPrivateMessage(params) {
            calls.push(`private:${params.userId}:${params.text}`)
            return { success: true, attempts: 1, providerMessageId: 9003 }
          },
        },
        replyRecordStore: {
          markAcked: async () => {},
          markSending: async () => {},
          markSent: async () => {},
          markFailed: async () => {},
        },
      },
    )

    assert.equal(result, 'sent')
    assert.deepEqual(calls, ['private:20:私聊恢复'])
  })
})
