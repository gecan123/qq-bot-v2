import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { finalizePersistedGroupMessage } from './core.js'

describe('finalizePersistedGroupMessage', () => {
  test('advances root runtime cursor through persisted ingress without pre-dispatch side path', async () => {
    const callOrder: string[] = []

    await finalizePersistedGroupMessage({
      groupId: 1,
      messageId: 1001,
      messageRowId: 10,
      senderId: 20,
      senderNickname: '用户20',
      createdAt: Date.now(),
      segments: [{ type: 'at', targetId: '999' }],
      persistedCreatedAt: new Date('2026-04-22T00:00:00Z'),
      rootRuntime: {
        async restore() {
          return { restoredCount: 0 }
        },
        async primeGroupCursor() {},
        requeuePendingPassiveMentions() {
          return 0
        },
        async markPassiveReplyDelivered() {},
        dispatchPassiveMentionIfMentioned() {
          return true
        },
        async ingestGroupMessage() {
          callOrder.push('ingest')
        },
        getSnapshot() {
          return null
        },
        enqueuePassiveMention() {},
        startPassiveExecution() {},
        stopPassiveExecution() {},
      },
    })

    assert.deepEqual(callOrder, ['ingest'])
  })

  test('uses persisted row metadata directly for runtime ingress without reread', async () => {
    const ingested: Array<{ messageRowId: number; messageId: number }> = []

    await finalizePersistedGroupMessage({
      groupId: 1,
      messageId: 1001,
      messageRowId: 10,
      senderId: 20,
      senderNickname: '用户20',
      createdAt: Date.now(),
      segments: [{ type: 'at', targetId: '999' }],
      persistedCreatedAt: new Date('2026-04-22T00:00:00Z'),
      rootRuntime: {
        async restore() {
          return { restoredCount: 0 }
        },
        async primeGroupCursor() {},
        requeuePendingPassiveMentions() {
          return 0
        },
        async markPassiveReplyDelivered() {},
        dispatchPassiveMentionIfMentioned() {
          return true
        },
        async ingestGroupMessage(input) {
          ingested.push({
            messageRowId: input.messageRowId,
            messageId: input.messageId,
          })
        },
        getSnapshot() {
          return null
        },
        enqueuePassiveMention() {},
        startPassiveExecution() {},
        stopPassiveExecution() {},
      },
    })

    assert.deepEqual(ingested, [{ messageRowId: 10, messageId: 1001 }])
  })
})
