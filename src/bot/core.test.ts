import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { finalizePersistedGroupMessage } from './core.js'

describe('finalizePersistedGroupMessage', () => {
  test('dispatches passive mention before advancing root runtime cursor', async () => {
    const callOrder: string[] = []

    await finalizePersistedGroupMessage({
      groupId: 1,
      messageId: 1001,
      senderId: 20,
      senderNickname: '用户20',
      createdAt: Date.now(),
      segments: [{ type: 'at', targetId: '999' }],
      loadPersistedMessage: async () => ({
        id: 10,
        groupId: BigInt(1),
        groupName: '测试群',
        mediaReferenceIds: [],
        messageId: BigInt(1001),
        senderId: BigInt(20),
        senderNickname: '用户20',
        senderGroupNickname: null,
        content: [],
        rawContent: null,
        rawMessage: null,
        searchText: '',
        resolvedText: '@bot hi',
        sentAt: new Date('2026-04-22T00:00:00Z'),
        createdAt: new Date('2026-04-22T00:00:00Z'),
      }),
      rootRuntime: {
        async restore() {
          return { restoredCount: 0 }
        },
        async primeGroupCursor() {},
        async markPassiveReplyDelivered() {},
        dispatchPassiveMentionIfMentioned() {
          callOrder.push('dispatch')
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

    assert.deepEqual(callOrder, ['dispatch', 'ingest'])
  })

  test('still dispatches passive mention when best-effort ingress reread fails', async () => {
    const dispatched: number[] = []

    await finalizePersistedGroupMessage({
      groupId: 1,
      messageId: 1001,
      senderId: 20,
      senderNickname: '用户20',
      createdAt: Date.now(),
      segments: [{ type: 'at', targetId: '999' }],
      loadPersistedMessage: async () => {
        throw new Error('db reread failed')
      },
      rootRuntime: {
        async restore() {
          return { restoredCount: 0 }
        },
        async primeGroupCursor() {},
        async markPassiveReplyDelivered() {},
        dispatchPassiveMentionIfMentioned(input: {
          groupId: number
          messageId: number
          senderId: number
          createdAt: number
          segments: { type: string; targetId?: string }[]
        }) {
          dispatched.push(input.messageId)
          return true
        },
        async ingestGroupMessage() {},
        getSnapshot() {
          return null
        },
        enqueuePassiveMention() {},
        startPassiveExecution() {},
        stopPassiveExecution() {},
      },
    })

    assert.deepEqual(dispatched, [1001])
  })
})
