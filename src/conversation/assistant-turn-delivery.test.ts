import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deliverAssistantTurn } from './assistant-turn-delivery.js'

describe('assistant turn delivery', () => {
  test('does not advance persisted delivery state when reply dry-run is enabled', async () => {
    const turnMutations: string[] = []
    let cursorAdvanced = false
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
          updateLastIncorporated: async () => {
            cursorAdvanced = true
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
    assert.equal(cursorAdvanced, false)
    assert.equal(compacted, false)
  })
})
