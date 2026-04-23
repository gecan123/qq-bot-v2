import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deliverAssistantTurn } from './assistant-turn-delivery.js'

describe('assistant turn delivery', () => {
  test('does not advance persisted delivery state when reply dry-run is enabled', async () => {
    const turnMutations: string[] = []
    let compacted = false
    let replyCalls = 0

    const deliveryResult = await deliverAssistantTurn(
      {
        id: 1,
        groupId: 1,
        senderThreadKey: 'sender:20',
        replyIntentId: 'intent-1',
        triggerMessageRowId: 10,
        incorporatedMessageRowId: 11,
        sequence: 1,
        replyToMessageId: 2001,
        mentionUserId: 20,
        providerMessageId: undefined,
        text: 'dry run reply',
        status: 'pending',
        attemptCount: 0,
        createdAt: new Date('2026-04-23T00:00:00Z'),
        updatedAt: new Date('2026-04-23T00:00:00Z'),
      },
      {
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
        assistantTurnStore: {
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
        compactor: async () => {
          compacted = true
        },
      },
    )

    assert.equal(deliveryResult, 'skipped')
    assert.equal(replyCalls, 0)
    assert.deepEqual(turnMutations, [])
    assert.equal(compacted, false)
  })

  test('persists provider ack before marking assistant turn sent', async () => {
    const turnMutations: string[] = []
    let compacted = false

    const deliveryResult = await deliverAssistantTurn(
      {
        id: 2,
        groupId: 1,
        senderThreadKey: 'sender:20',
        replyIntentId: 'intent-2',
        triggerMessageRowId: 12,
        incorporatedMessageRowId: 12,
        sequence: 2,
        replyToMessageId: 2002,
        mentionUserId: 20,
        providerMessageId: undefined,
        text: '正式发送',
        status: 'pending',
        attemptCount: 0,
        createdAt: new Date('2026-04-23T00:00:00Z'),
        updatedAt: new Date('2026-04-23T00:00:00Z'),
      },
      {
        sender: {
          async replyToMessage() {
            return { success: true, attempts: 1, providerMessageId: 9001 }
          },
          async sendMessage() {
            return { success: true, attempts: 1 }
          },
        },
        assistantTurnStore: {
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
        compactor: async () => {
          compacted = true
        },
      },
    )

    assert.equal(deliveryResult, 'sent')
    assert.deepEqual(turnMutations, ['sending:2', 'acked:2:9001', 'sent:2'])
    assert.equal(compacted, true)
  })

  test('finalizes acked assistant turns without sending again', async () => {
    const turnMutations: string[] = []
    let replyCalls = 0

    const deliveryResult = await deliverAssistantTurn(
      {
        id: 3,
        groupId: 1,
        senderThreadKey: 'sender:20',
        replyIntentId: 'intent-3',
        triggerMessageRowId: 13,
        incorporatedMessageRowId: 13,
        sequence: 3,
        replyToMessageId: 2003,
        mentionUserId: 20,
        providerMessageId: 9002,
        text: '补收尾',
        status: 'acked',
        attemptCount: 1,
        createdAt: new Date('2026-04-23T00:00:00Z'),
        updatedAt: new Date('2026-04-23T00:00:00Z'),
      },
      {
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
          markAcked: async () => {
            turnMutations.push('acked')
          },
          markSending: async () => {
            turnMutations.push('sending')
          },
          markSent: async (id) => {
            turnMutations.push(`sent:${id}`)
          },
          markFailed: async () => {
            turnMutations.push('failed')
          },
        },
        compactor: async () => {},
      },
    )

    assert.equal(deliveryResult, 'sent')
    assert.equal(replyCalls, 0)
    assert.deepEqual(turnMutations, ['sent:3'])
  })
})
