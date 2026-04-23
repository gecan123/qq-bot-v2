import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createRootRuntimeManager, getGroupRuntimeKey } from './root-runtime.js'
import {
  ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  type CreateRootRuntimeSnapshotInput,
  type RootRuntimeSnapshotRecord,
} from './types.js'

function makeSnapshotRecord(input: CreateRootRuntimeSnapshotInput, id = 1): RootRuntimeSnapshotRecord {
  return {
    id,
    runtimeKey: input.runtimeKey,
    groupId: input.groupId,
    schemaVersion: input.schemaVersion,
    contextSnapshot: input.contextSnapshot,
    sessionSnapshot: input.sessionSnapshot,
    lastObservedMessageRowId: input.lastObservedMessageRowId,
    createdAt: new Date('2026-04-22T00:00:00Z'),
    updatedAt: new Date('2026-04-22T00:00:00Z'),
  }
}

describe('root runtime manager', () => {
  test('restores persisted snapshots by group id', async () => {
    const restored = [
      makeSnapshotRecord({
        runtimeKey: getGroupRuntimeKey(1),
        groupId: 1,
        schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
        contextSnapshot: { messages: [] },
        sessionSnapshot: {
          focusedStateId: 'qq_group:1',
          stateStack: ['qq_group:1'],
          unreadMessages: [],
          senderContinuities: [],
          proactiveCandidates: [],
          recentObservedMessageRowIds: [],
          lastWakeAt: null,
        },
        lastObservedMessageRowId: 12,
      }),
    ]

    const manager = createRootRuntimeManager({
      selfNumber: 999,
      snapshotStore: {
        listByGroupIds: async (groupIds) => {
          assert.deepEqual(groupIds, [1])
          return restored
        },
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    const result = await manager.restore([1])
    assert.deepEqual(result, { restoredCount: 1 })
    assert.equal(manager.getSnapshot(1)?.lastObservedMessageRowId, 12)
  })

  test('ingests all group messages into runtime unread state and updates cursors', async () => {
    const persistedInputs: CreateRootRuntimeSnapshotInput[] = []
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => {
          persistedInputs.push(input)
          return makeSnapshotRecord(input, persistedInputs.length)
        },
      },
    })

    await manager.restore([1])
    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 5,
      messageId: 1005,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'text', content: 'hello' }],
      createdAt: new Date('2026-04-22T00:00:00Z'),
    })

    const snapshot = manager.getSnapshot(1)
    assert.ok(snapshot)
    assert.equal(snapshot.lastObservedMessageRowId, 5)
    assert.equal(snapshot.sessionSnapshot.unreadMessages.length, 1)
    assert.deepEqual(snapshot.sessionSnapshot.unreadMessages[0], {
      messageRowId: 5,
      messageId: 1005,
      senderId: 20,
      senderNickname: '用户20',
      mentionedSelf: false,
      createdAt: '2026-04-22T00:00:00.000Z',
    })
    assert.deepEqual(snapshot.sessionSnapshot.senderContinuities, [
      {
        senderThreadKey: 'sender:20',
        senderId: 20,
        lastSeenMessageRowId: 5,
        lastMaterializedMessageRowId: null,
        updatedAt: '2026-04-22T00:00:00.000Z',
      },
    ])
    assert.deepEqual(snapshot.contextSnapshot.messages, [
      {
        role: 'user',
        kind: 'group_message',
        orderKey: 5,
        senderId: 20,
        content: '[QQ消息]\n用户20: hello',
      },
    ])
    assert.deepEqual(snapshot.sessionSnapshot.recentObservedMessageRowIds, [5])
    assert.equal(persistedInputs.length, 1)
  })

  test('caps sender continuity records by recency', async () => {
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      senderContinuityLimit: 2,
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.restore([1])
    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 1,
      messageId: 101,
      senderId: 10,
      senderNickname: 'A',
      segments: [{ type: 'text', content: 'a' }],
      createdAt: new Date('2026-04-22T00:00:00Z'),
    })
    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 2,
      messageId: 102,
      senderId: 20,
      senderNickname: 'B',
      segments: [{ type: 'text', content: 'b' }],
      createdAt: new Date('2026-04-22T00:00:01Z'),
    })
    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 3,
      messageId: 103,
      senderId: 30,
      senderNickname: 'C',
      segments: [{ type: 'at', targetId: '999' }],
      createdAt: new Date('2026-04-22T00:00:02Z'),
    })

    const snapshot = manager.getSnapshot(1)
    assert.ok(snapshot)
    assert.deepEqual(
      snapshot.sessionSnapshot.senderContinuities.map((item) => item.senderId),
      [30, 20],
    )
  })

  test('ignores duplicate ingress that was already observed', async () => {
    const upserts: CreateRootRuntimeSnapshotInput[] = []
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      snapshotStore: {
        listByGroupIds: async () => [
          makeSnapshotRecord({
            runtimeKey: getGroupRuntimeKey(1),
            groupId: 1,
            schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            contextSnapshot: { messages: [] },
            sessionSnapshot: {
              focusedStateId: 'qq_group:1',
              stateStack: ['qq_group:1'],
              unreadMessages: [],
              senderContinuities: [],
              proactiveCandidates: [],
              recentObservedMessageRowIds: [9, 10],
              lastWakeAt: null,
            },
            lastObservedMessageRowId: 10,
          }),
        ],
        upsert: async (input) => {
          upserts.push(input)
          return makeSnapshotRecord(input, upserts.length + 1)
        },
      },
    })

    await manager.restore([1])
    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 9,
      messageId: 109,
      senderId: 20,
      senderNickname: '重复消息',
      segments: [{ type: 'text', content: 'duplicate' }],
      createdAt: new Date('2026-04-22T00:00:00Z'),
    })
    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 10,
      messageId: 110,
      senderId: 20,
      senderNickname: '重复消息',
      segments: [{ type: 'text', content: 'dup' }],
      createdAt: new Date('2026-04-22T00:00:01Z'),
    })

    assert.equal(upserts.length, 0)
    assert.equal(manager.getSnapshot(1)?.lastObservedMessageRowId, 10)
  })

  test('skips incompatible snapshot schema versions on restore', async () => {
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      snapshotStore: {
        listByGroupIds: async () => [
          makeSnapshotRecord({
            runtimeKey: getGroupRuntimeKey(1),
            groupId: 1,
            schemaVersion: 999,
            contextSnapshot: { messages: [] },
            sessionSnapshot: {
              focusedStateId: 'qq_group:1',
              stateStack: ['qq_group:1'],
              unreadMessages: [],
              senderContinuities: [],
              proactiveCandidates: [],
              recentObservedMessageRowIds: [],
              lastWakeAt: null,
            },
            lastObservedMessageRowId: 88,
          }),
        ],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    const result = await manager.restore([1])
    assert.deepEqual(result, { restoredCount: 0 })
    assert.equal(manager.getSnapshot(1), null)
  })

  test('accepts older unseen rows and keeps group cursor monotonic', async () => {
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      snapshotStore: {
        listByGroupIds: async () => [
          makeSnapshotRecord({
            runtimeKey: getGroupRuntimeKey(1),
            groupId: 1,
            schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            contextSnapshot: {
              messages: [
                {
                  role: 'user',
                  kind: 'group_message',
                  orderKey: 10,
                  senderId: 30,
                  content: '[QQ消息]\n用户30: newer',
                },
              ],
            },
            sessionSnapshot: {
              focusedStateId: 'qq_group:1',
              stateStack: ['qq_group:1'],
              unreadMessages: [],
              senderContinuities: [],
              proactiveCandidates: [],
              recentObservedMessageRowIds: [8],
              lastWakeAt: null,
            },
            lastObservedMessageRowId: 10,
          }),
        ],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.restore([1])
    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 9,
      messageId: 109,
      senderId: 20,
      senderNickname: '补到的旧消息',
      segments: [{ type: 'text', content: 'older but unseen' }],
      createdAt: new Date('2026-04-22T00:00:00Z'),
    })

    const snapshot = manager.getSnapshot(1)
    assert.ok(snapshot)
    assert.equal(snapshot.lastObservedMessageRowId, 10)
    assert.deepEqual(snapshot.sessionSnapshot.recentObservedMessageRowIds, [8, 9])
    assert.deepEqual(
      snapshot.sessionSnapshot.unreadMessages.map((message) => message.messageRowId),
      [9],
    )
    assert.deepEqual(snapshot.contextSnapshot.messages.map((message) => message.orderKey), [9, 10])
  })

  test('merges queued passive mentions by group before handing them to the processor', async () => {
    const batches: Array<{ groupId: number; messageIds: number[] }> = []
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      passiveMergeWindowMs: 1,
      passiveWorker: async (batch) => {
        batches.push({
          groupId: batch.groupId,
          messageIds: batch.events.map((event) => event.messageId),
        })
        return { leftoverEvents: [] }
      },
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })
    manager.startPassiveExecution()
    manager.enqueuePassiveMention({ groupId: 1, messageId: 11, senderId: 1, createdAt: 1 })
    manager.enqueuePassiveMention({ groupId: 1, messageId: 12, senderId: 1, createdAt: 2 })
    manager.enqueuePassiveMention({ groupId: 2, messageId: 21, senderId: 2, createdAt: 3 })

    const startedAt = Date.now()
    while (batches.length < 2) {
      if (Date.now() - startedAt > 500) {
        throw new Error('waitFor timeout')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    manager.stopPassiveExecution()

    assert.deepEqual(batches, [
      { groupId: 1, messageIds: [11, 12] },
      { groupId: 2, messageIds: [21] },
    ])
  })

  test('dispatchPassiveMentionIfMentioned only enqueues direct @self messages', async () => {
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      passiveWorker: async () => ({ leftoverEvents: [] }),
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    manager.startPassiveExecution()
    const dispatched = manager.dispatchPassiveMentionIfMentioned({
      groupId: 1,
      messageId: 101,
      senderId: 10,
      createdAt: 1,
      segments: [{ type: 'at', targetId: '999' }],
    })
    const ignored = manager.dispatchPassiveMentionIfMentioned({
      groupId: 1,
      messageId: 102,
      senderId: 10,
      createdAt: 2,
      segments: [{ type: 'text', content: 'hello' }],
    })
    manager.stopPassiveExecution()

    assert.equal(dispatched, true)
    assert.equal(ignored, false)
  })

  test('marks passive reply delivery into sender continuity progress', async () => {
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.restore([1])
    await manager.markPassiveReplyDelivered({
      groupId: 1,
      senderId: 20,
      incorporatedMessageRowId: 33,
      text: '你好',
    })

    const snapshot = manager.getSnapshot(1)
    assert.ok(snapshot)
    assert.deepEqual(snapshot.contextSnapshot.messages, [
      {
        role: 'model',
        kind: 'assistant_turn',
        orderKey: 33,
        senderId: 20,
        content: '你好',
      },
    ])
    assert.deepEqual(snapshot.sessionSnapshot.senderContinuities, [
      {
        senderThreadKey: 'sender:20',
        senderId: 20,
        lastSeenMessageRowId: 33,
        lastMaterializedMessageRowId: 33,
        updatedAt: snapshot.sessionSnapshot.senderContinuities[0]?.updatedAt,
      },
    ])
  })
})
