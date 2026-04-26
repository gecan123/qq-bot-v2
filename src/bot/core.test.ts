import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { finalizePersistedGroupMessage, finalizePersistedPrivateMessage } from './core.js'

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
        async emitRuntimeEvent(event) {
          assert.equal(event.eventKind, 'group_message')
          callOrder.push('event')
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

    assert.deepEqual(callOrder, ['event'])
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
        async emitRuntimeEvent(event) {
          assert.equal(event.eventKind, 'group_message')
          assert.ok(event.message)
          ingested.push({
            messageRowId: event.message.messageRowId,
            messageId: event.message.messageId,
          })
        },
        async primeGroupCursor() {},
        requeuePendingPassiveMentions() {
          return 0
        },
        async markPassiveReplyDelivered() {},
        dispatchPassiveMentionIfMentioned() {
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

    assert.deepEqual(ingested, [{ messageRowId: 10, messageId: 1001 }])
  })

  test('keeps backfilled messages as snapshot-only runtime ingress', async () => {
    let executeDecisions: boolean | undefined

    await finalizePersistedGroupMessage({
      groupId: 1,
      messageId: 1001,
      messageRowId: 10,
      senderId: 20,
      senderNickname: '用户20',
      createdAt: Date.now(),
      segments: [{ type: 'at', targetId: '999' }],
      dispatchMention: false,
      persistedCreatedAt: new Date('2026-04-22T00:00:00Z'),
      rootRuntime: {
        async restore() {
          return { restoredCount: 0 }
        },
        async emitRuntimeEvent(_event, options) {
          executeDecisions = options?.executeDecisions
        },
        async primeGroupCursor() {},
        requeuePendingPassiveMentions() {
          return 0
        },
        async markPassiveReplyDelivered() {},
        dispatchPassiveMentionIfMentioned() {
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

    assert.equal(executeDecisions, false)
  })
})

describe('finalizePersistedPrivateMessage', () => {
  test('emits private runtime event with qq_private scene and live decision flag', async () => {
    let seenEventKind: string | undefined
    let seenSceneKind: string | undefined
    let executeDecisions: boolean | undefined

    await finalizePersistedPrivateMessage({
      userId: 20,
      messageId: 2001,
      messageRowId: 30,
      senderId: 20,
      senderNickname: '用户20',
      createdAt: Date.now(),
      segments: [{ type: 'text', content: '你好' }],
      persistedCreatedAt: new Date('2026-04-22T00:00:00Z'),
      rootRuntime: {
        async restore() {
          return { restoredCount: 0 }
        },
        async emitRuntimeEvent(event, options) {
          seenEventKind = event.eventKind
          seenSceneKind = event.message?.sceneKind
          executeDecisions = options?.executeDecisions
        },
        async ingestGroupMessage() {},
        async primeGroupCursor() {},
        requeuePendingPassiveMentions() {
          return 0
        },
        async markPassiveReplyDelivered() {},
        dispatchPassiveMentionIfMentioned() {
          return false
        },
        getSnapshot() {
          return null
        },
        enqueuePassiveMention() {},
        startPassiveExecution() {},
        stopPassiveExecution() {},
      },
    })

    assert.equal(seenEventKind, 'private_message')
    assert.equal(seenSceneKind, 'qq_private')
    assert.equal(executeDecisions, true)
  })
})
