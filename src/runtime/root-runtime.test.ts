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
          ambientAuditCandidates: [],
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
    assert.deepEqual(snapshot.sessionSnapshot.sceneRecords, [
      {
        sceneId: 'qq_group:1',
        kind: 'qq_group',
        groupId: 1,
        unreadCount: 1,
        lastObservedMessageRowId: 5,
        lastMaterializedReplyRowId: null,
        lastFocusedAt: null,
        lastSpokeAt: null,
        outstandingCueIds: [],
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
              ambientAuditCandidates: [],
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
              ambientAuditCandidates: [],
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
              ambientAuditCandidates: [],
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
    assert.deepEqual(snapshot.sessionSnapshot.sceneRecords, [
      {
        sceneId: 'qq_group:1',
        kind: 'qq_group',
        groupId: 1,
        unreadCount: 0,
        lastObservedMessageRowId: null,
        lastMaterializedReplyRowId: 33,
        lastFocusedAt: null,
        lastSpokeAt: snapshot.sessionSnapshot.sceneRecords?.[0]?.lastSpokeAt ?? null,
        outstandingCueIds: [],
      },
    ])
  })

  test('promotes @self ingress into a stable pending cue and marks it replied after delivery', async () => {
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.restore([1])
    const mentioned = manager.dispatchPassiveMentionIfMentioned({
      groupId: 1,
      messageId: 1005,
      senderId: 20,
      createdAt: 1,
      segments: [{ type: 'at', targetId: '999' }],
    })
    assert.equal(mentioned, true)

    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 5,
      messageId: 1005,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'at', targetId: '999' }],
      createdAt: new Date('2026-04-22T00:00:00Z'),
    })

    assert.deepEqual(manager.getSnapshot(1)?.sessionSnapshot.outstandingCues, [
      {
        cueId: 'qq_group:1:message:5:reply_to_message',
        sceneId: 'qq_group:1',
        cueKind: 'message',
        triggerMessageRowId: 5,
        messageId: 1005,
        senderId: 20,
        senderNickname: '用户20',
        addressedToAgent: true,
        cueStrength: 'strong',
        replyModeHint: 'anchored',
        preferredDeliveryMode: 'reply_to_message',
        mustReplyOverride: true,
        status: 'pending',
        createdAt: '2026-04-22T00:00:00.000Z',
      },
    ])

    await manager.markPassiveReplyDelivered({
      groupId: 1,
      senderId: 20,
      incorporatedMessageRowId: 5,
      text: '收到',
    })

    assert.equal(manager.getSnapshot(1)?.sessionSnapshot.outstandingCues?.[0]?.status, 'replied')
    assert.deepEqual(manager.getSnapshot(1)?.sessionSnapshot.sceneRecords?.[0]?.outstandingCueIds, [])
  })

  test('requeues pending mentioned unread messages from restored snapshot', async () => {
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
        listByGroupIds: async () => [
          makeSnapshotRecord({
            runtimeKey: getGroupRuntimeKey(1),
            groupId: 1,
            schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            contextSnapshot: { messages: [] },
            sessionSnapshot: {
              focusedStateId: 'qq_group:1',
              stateStack: ['qq_group:1'],
              unreadMessages: [
                {
                  messageRowId: 11,
                  messageId: 1001,
                  senderId: 20,
                  senderNickname: '用户20',
                  mentionedSelf: true,
                  createdAt: '2026-04-22T00:00:00.000Z',
                },
                {
                  messageRowId: 12,
                  messageId: 1002,
                  senderId: 20,
                  senderNickname: '用户20',
                  mentionedSelf: true,
                  createdAt: '2026-04-22T00:00:01.000Z',
                },
                {
                  messageRowId: 13,
                  messageId: 1003,
                  senderId: 30,
                  senderNickname: '用户30',
                  mentionedSelf: false,
                  createdAt: '2026-04-22T00:00:02.000Z',
                },
              ],
              senderContinuities: [
                {
                  senderThreadKey: 'sender:20',
                  senderId: 20,
                  lastSeenMessageRowId: 12,
                  lastMaterializedMessageRowId: 10,
                  updatedAt: '2026-04-22T00:00:01.000Z',
                },
              ],
              ambientAuditCandidates: [],
              recentObservedMessageRowIds: [11, 12, 13],
              lastWakeAt: null,
            },
            lastObservedMessageRowId: 13,
          }),
        ],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.restore([1])
    const requeued = manager.requeuePendingPassiveMentions([1])
    assert.equal(requeued, 2)
    manager.startPassiveExecution()

    const startedAt = Date.now()
    while (batches.length < 1) {
      if (Date.now() - startedAt > 500) {
        throw new Error('waitFor timeout')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    manager.stopPassiveExecution()

    assert.deepEqual(batches, [{ groupId: 1, messageIds: [1001, 1002] }])
  })

  test('keeps startup mentions out of mailbox until passive execution is started', async () => {
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

    await manager.restore([1])

    const mentioned = manager.dispatchPassiveMentionIfMentioned({
      groupId: 1,
      messageId: 1002,
      senderId: 20,
      createdAt: new Date('2026-04-22T00:00:01Z').getTime(),
      segments: [{ type: 'at', targetId: '999' }],
    })
    assert.equal(mentioned, true)

    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 12,
      messageId: 1002,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'at', targetId: '999' }],
      createdAt: new Date('2026-04-22T00:00:01Z'),
    })

    const requeued = manager.requeuePendingPassiveMentions([1])
    assert.equal(requeued, 1)

    manager.startPassiveExecution()

    const startedAt = Date.now()
    while (batches.length < 1) {
      if (Date.now() - startedAt > 500) {
        throw new Error('waitFor timeout')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    manager.stopPassiveExecution()

    assert.deepEqual(batches, [{ groupId: 1, messageIds: [1002] }])
  })

  test('requeue preserves startup order for unread mentions that arrived before passive execution started', async () => {
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
        listByGroupIds: async () => [
          makeSnapshotRecord({
            runtimeKey: getGroupRuntimeKey(1),
            groupId: 1,
            schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            contextSnapshot: { messages: [] },
            sessionSnapshot: {
              focusedStateId: 'qq_group:1',
              stateStack: ['qq_group:1'],
              unreadMessages: [
                {
                  messageRowId: 11,
                  messageId: 1001,
                  senderId: 20,
                  senderNickname: '用户20',
                  mentionedSelf: true,
                  createdAt: '2026-04-22T00:00:00.000Z',
                },
              ],
              senderContinuities: [
                {
                  senderThreadKey: 'sender:20',
                  senderId: 20,
                  lastSeenMessageRowId: 11,
                  lastMaterializedMessageRowId: 10,
                  updatedAt: '2026-04-22T00:00:00.000Z',
                },
              ],
              ambientAuditCandidates: [],
              recentObservedMessageRowIds: [11],
              lastWakeAt: null,
            },
            lastObservedMessageRowId: 11,
          }),
        ],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.restore([1])

    const mentioned = manager.dispatchPassiveMentionIfMentioned({
      groupId: 1,
      messageId: 1002,
      senderId: 20,
      createdAt: new Date('2026-04-22T00:00:01Z').getTime(),
      segments: [{ type: 'at', targetId: '999' }],
    })
    assert.equal(mentioned, true)

    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 12,
      messageId: 1002,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'at', targetId: '999' }],
      createdAt: new Date('2026-04-22T00:00:01Z'),
    })

    const requeued = manager.requeuePendingPassiveMentions([1])
    assert.equal(requeued, 2)

    manager.startPassiveExecution()

    const startedAt = Date.now()
    while (batches.length < 1) {
      if (Date.now() - startedAt > 500) {
        throw new Error('waitFor timeout')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    manager.stopPassiveExecution()

    assert.deepEqual(batches, [{ groupId: 1, messageIds: [1001, 1002] }])
  })

  test('clears incorporated sender unread messages after passive reply delivery', async () => {
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
              unreadMessages: [
                {
                  messageRowId: 10,
                  messageId: 1010,
                  senderId: 20,
                  senderNickname: '用户20',
                  mentionedSelf: true,
                  createdAt: '2026-04-22T00:00:00.000Z',
                },
                {
                  messageRowId: 11,
                  messageId: 1011,
                  senderId: 20,
                  senderNickname: '用户20',
                  mentionedSelf: false,
                  createdAt: '2026-04-22T00:00:01.000Z',
                },
                {
                  messageRowId: 12,
                  messageId: 1012,
                  senderId: 30,
                  senderNickname: '用户30',
                  mentionedSelf: false,
                  createdAt: '2026-04-22T00:00:02.000Z',
                },
              ],
              senderContinuities: [],
              ambientAuditCandidates: [],
              recentObservedMessageRowIds: [10, 11, 12],
              lastWakeAt: null,
            },
            lastObservedMessageRowId: 12,
          }),
        ],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.restore([1])
    await manager.markPassiveReplyDelivered({
      groupId: 1,
      senderId: 20,
      incorporatedMessageRowId: 11,
      text: '已回复',
    })

    assert.deepEqual(
      manager.getSnapshot(1)?.sessionSnapshot.unreadMessages.map((message) => message.messageRowId),
      [12],
    )
  })


  test('executes live @self opportunities directly when unified executor is provided', async () => {
    const opportunities: string[] = []
    const batches: Array<{ groupId: number; messageIds: number[] }> = []
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      passiveMergeWindowMs: 1,
      passiveWorker: async (batch) => {
        batches.push({ groupId: batch.groupId, messageIds: batch.events.map((event) => event.messageId) })
        return { leftoverEvents: [] }
      },
      replyExecutor: {
        async execute(opportunity) {
          opportunities.push(`${opportunity.sourceKind}:${opportunity.opportunityId}:${opportunity.deliveryMode}`)
          return {
            decision: {
              opportunity,
              outcome: 'sendable_reply',
              policy: {
                shouldGenerate: true,
                shouldCreateReplyRecord: true,
                shouldDeliver: true,
                shouldAudit: false,
                reason: opportunity.reason,
              },
              deliveryMode: opportunity.deliveryMode,
              dryRun: false,
              reason: opportunity.reason,
            },
            deliveryResult: 'skipped',
          }
        },
      },
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    manager.startPassiveExecution()
    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 42,
      messageId: 10042,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'at', targetId: '999' }],
      createdAt: new Date('2026-04-22T00:00:00Z'),
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    manager.stopPassiveExecution()

    assert.deepEqual(opportunities, ['mention:qq_group:1:message:42:mention:reply_to_message'])
    assert.deepEqual(batches, [])
  })

  test('snapshot-only ingest records mention cues without executing reply decisions', async () => {
    const opportunities: string[] = []
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      replyExecutor: {
        async execute(opportunity) {
          opportunities.push(opportunity.opportunityId)
          return {
            decision: {
              opportunity,
              outcome: 'sendable_reply',
              policy: {
                shouldGenerate: true,
                shouldCreateReplyRecord: true,
                shouldDeliver: true,
                shouldAudit: false,
                reason: opportunity.reason,
              },
              deliveryMode: opportunity.deliveryMode,
              dryRun: false,
              reason: opportunity.reason,
            },
            deliveryResult: 'skipped',
          }
        },
      },
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 42,
      messageId: 10042,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'at', targetId: '999' }],
      createdAt: new Date('2026-04-22T00:00:00Z'),
    }, { executeDecisions: false })

    assert.deepEqual(opportunities, [])
    const snapshot = manager.getSnapshot(1)
    assert.ok(snapshot)
    assert.deepEqual(
      (snapshot.sessionSnapshot.outstandingCues ?? []).map((cue) => cue.cueId),
      ['qq_group:1:message:42:reply_to_message'],
    )
  })

  test('scores ambient reply probability from configured baseline and message shape', async () => {
    const probabilities: number[] = []
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      ambientAuditEnabled: true,
      ambientReplyBaseProbability: 0.1,
      replyExecutor: {
        async execute(opportunity) {
          probabilities.push(opportunity.replyProbability)
          return {
            decision: {
              opportunity,
              outcome: 'opportunity_detected',
              policy: {
                shouldGenerate: false,
                shouldCreateReplyRecord: false,
                shouldDeliver: false,
                shouldAudit: true,
                reason: opportunity.reason,
              },
              deliveryMode: opportunity.deliveryMode,
              dryRun: true,
              reason: opportunity.reason,
            },
            deliveryResult: 'skipped',
          }
        },
      },
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 43,
      messageId: 10043,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'text', content: '有人知道这个怎么处理吗？' }],
      createdAt: new Date('2026-04-22T00:00:00Z'),
    })

    assert.equal(probabilities.length, 1)
    assert.ok((probabilities[0] ?? 0) > 0.1)
  })
  test('creates non-authoritative proactive candidate artifacts for ordinary messages when ambient audit is enabled', async () => {
    const opportunities: string[] = []
    const persistedInputs: CreateRootRuntimeSnapshotInput[] = []
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      ambientAuditEnabled: true,
      replyExecutor: {
        async execute(opportunity) {
          opportunities.push(`${opportunity.sourceKind}:${opportunity.opportunityId}:${opportunity.deliveryMode}`)
          return {
            decision: {
              opportunity,
              outcome: 'would_reply_dry_run',
              policy: {
                shouldGenerate: true,
                shouldCreateReplyRecord: false,
                shouldDeliver: false,
                shouldAudit: true,
                artifactKind: 'proactive_candidate',
                auditKind: 'proactive_candidate',
                reason: opportunity.reason,
              },
              deliveryMode: opportunity.deliveryMode,
              dryRun: true,
              reason: opportunity.reason,
            },
            deliveryResult: 'skipped',
          }
        },
      },
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => {
          persistedInputs.push(input)
          return makeSnapshotRecord(input, persistedInputs.length)
        },
      },
    })

    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 42,
      messageId: 10042,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'text', content: '普通消息' }],
      createdAt: new Date('2026-04-22T00:00:00Z'),
    })

    assert.deepEqual(opportunities, ['ambient_message:qq_group:1:message:42:ambient:send_message'])
    assert.deepEqual(
      manager.getSnapshot(1)?.contextSnapshot.messages.map((message) => message.kind),
      ['group_message'],
    )
    assert.deepEqual(manager.getSnapshot(1)?.sessionSnapshot.ambientAuditCandidates, [])
  })

  test('routes group message ingress through runtime event producer', async () => {
    const opportunities: string[] = []
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      ambientAuditEnabled: true,
      replyExecutor: {
        async execute(opportunity) {
          opportunities.push(opportunity.opportunityId)
          return {
            decision: {
              opportunity,
              outcome: 'opportunity_detected',
              policy: {
                shouldGenerate: false,
                shouldCreateReplyRecord: false,
                shouldDeliver: false,
                shouldAudit: true,
                reason: opportunity.reason,
              },
              deliveryMode: opportunity.deliveryMode,
              dryRun: true,
              reason: opportunity.reason,
            },
            deliveryResult: 'skipped',
          }
        },
      },
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.emitRuntimeEvent({
      eventKind: 'group_message',
      groupId: 1,
      createdAt: new Date('2026-04-22T00:00:00Z'),
      message: {
        groupId: 1,
        messageRowId: 77,
        messageId: 10077,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '怎么处理这个？' }],
        createdAt: new Date('2026-04-22T00:00:00Z'),
      },
    })

    assert.deepEqual(opportunities, ['qq_group:1:message:77:ambient'])
  })

  test('manual wake event only updates runtime wake state', async () => {
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      replyExecutor: {
        async execute() {
          throw new Error('wake event must not execute replies')
        },
      },
      snapshotStore: {
        listByGroupIds: async () => [],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.emitRuntimeEvent({
      eventKind: 'manual_wake',
      groupId: 1,
      createdAt: new Date('2026-04-22T00:01:00Z'),
    })

    assert.equal(manager.getSnapshot(1)?.sessionSnapshot.lastWakeAt, '2026-04-22T00:01:00.000Z')
  })

  test('restores proactive budget buckets from durable snapshot state', async () => {
    const opportunities: Array<{ id: string; gates: string[] | undefined }> = []
    const manager = createRootRuntimeManager({
      selfNumber: 999,
      ambientAuditEnabled: true,
      proactivePolicy: {
        activeChatMessageThreshold: 99,
        activeChatWindowMs: 120_000,
        cooldownMs: 600_000,
        generationBudgetPerHour: 1,
        candidateBudgetPerDay: 1,
      },
      replyExecutor: {
        async execute(opportunity) {
          opportunities.push({ id: opportunity.opportunityId, gates: opportunity.gateReasons })
          return {
            decision: {
              opportunity,
              outcome: 'policy_suppressed',
              policy: {
                shouldGenerate: false,
                shouldCreateReplyRecord: false,
                shouldDeliver: false,
                shouldAudit: true,
                reason: opportunity.reason,
                gateReasons: opportunity.gateReasons,
              },
              deliveryMode: opportunity.deliveryMode,
              dryRun: true,
              reason: opportunity.reason,
            },
            deliveryResult: 'skipped',
          }
        },
      },
      snapshotStore: {
        listByGroupIds: async () => [makeSnapshotRecord({
          runtimeKey: getGroupRuntimeKey(1),
          groupId: 1,
          schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: { messages: [] },
          sessionSnapshot: {
            focusedStateId: 'qq_group:1',
            stateStack: ['qq_group:1'],
            unreadMessages: [],
            senderContinuities: [],
            ambientAuditCandidates: [],
            proactiveCandidateArtifacts: [{
              artifactKind: 'proactive_candidate',
              opportunityId: 'old-candidate',
              runtimeKey: getGroupRuntimeKey(1),
              groupId: 1,
              sceneId: 'qq_group:1',
              sourceKind: 'ambient_message',
              triggerMessageRowId: 10,
              incorporatedMessageRowId: 10,
              createdAt: '2026-04-22T00:00:00.000Z',
              expiresAt: '2026-04-29T00:00:00.000Z',
              score: 0.2,
              gateReasons: [],
              candidateText: 'old',
              termination: 'final_answer',
              status: 'candidate_generated',
            }],
            proactiveGenerationAttempts: [{ opportunityId: 'old-attempt', attemptedAt: '2026-04-22T00:00:00.000Z' }],
            recentObservedMessageRowIds: [],
            lastWakeAt: null,
          },
          lastObservedMessageRowId: 10,
        })],
        upsert: async (input) => makeSnapshotRecord(input),
      },
    })

    await manager.restore([1])
    await manager.ingestGroupMessage({
      groupId: 1,
      messageRowId: 11,
      messageId: 10011,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'text', content: '怎么处理这个？' }],
      createdAt: new Date('2026-04-22T00:10:00Z'),
    })

    assert.deepEqual(opportunities[0]?.gates, ['generation_budget', 'candidate_budget'])
  })
})
