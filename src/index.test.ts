import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { recoverStartupAndStartPassiveRuntime, replayPersistedRootRuntimeDelta, startRuntimeSchedulerTicks } from './index.js'
import type { RootRuntimeManager, PersistedGroupMessageIngress } from './runtime/root-runtime.js'
import type { ParsedSegment } from './types/message-segments.js'

describe('replayPersistedRootRuntimeDelta', () => {
  test('replays persisted mentions back into passive runtime queue during startup recovery', async () => {
    const calls: string[] = []
    const rootRuntime: RootRuntimeManager = {
      async restore() {
        return { restoredCount: 0 }
      },
      async emitRuntimeEvent() {},
      async ingestGroupMessage(input: PersistedGroupMessageIngress, options) {
        calls.push(`ingest:${input.messageRowId}:${options?.executeDecisions === false ? 'snapshot-only' : 'live'}`)
      },
      async primeGroupCursor(input) {
        calls.push(`prime:${input.lastObservedMessageRowId}`)
      },
      requeuePendingPassiveMentions() {
        calls.push('requeue')
        return 0
      },
      async markPassiveReplyDelivered() {},
      dispatchPassiveMentionIfMentioned(input: {
        groupId: number
        messageId: number
        senderId: number
        createdAt: number
        segments: ParsedSegment[]
      }) {
        calls.push(`unused-dispatch:${input.messageId}`)
        return input.messageId === 1002
      },
      getSnapshot() {
        return {
          lastObservedMessageRowId: 10,
        } as ReturnType<RootRuntimeManager['getSnapshot']>
      },
      enqueuePassiveMention() {},
      startPassiveExecution() {},
      stopPassiveExecution() {},
    }

    await replayPersistedRootRuntimeDelta({
      groupIds: [1],
      rootRuntime,
      getMessagesAfterRowId: async (groupId, afterRowId) => {
        assert.equal(groupId, 1)
        assert.equal(afterRowId, 10)
        return [
          {
            id: 11,
            groupId: BigInt(1),
            groupName: '测试群',
            mediaReferenceIds: [],
            messageId: BigInt(1001),
            senderId: BigInt(20),
            senderNickname: '用户20',
            senderGroupNickname: null,
            content: [{ type: 'text', content: '普通消息' }],
            rawContent: null,
            rawMessage: null,
            searchText: '',
            resolvedText: null,
            sentAt: null,
            createdAt: new Date('2026-04-22T00:00:00Z'),
          },
          {
            id: 12,
            groupId: BigInt(1),
            groupName: '测试群',
            mediaReferenceIds: [],
            messageId: BigInt(1002),
            senderId: BigInt(20),
            senderNickname: '用户20',
            senderGroupNickname: null,
            content: [{ type: 'at', targetId: '999' }],
            rawContent: null,
            rawMessage: null,
            searchText: '',
            resolvedText: null,
            sentAt: null,
            createdAt: new Date('2026-04-22T00:00:01Z'),
          },
        ]
      },
    })

    assert.deepEqual(calls, [
      'ingest:11:snapshot-only',
      'ingest:12:snapshot-only',
    ])
  })

  test('primes cursor instead of replaying full history when no snapshot exists', async () => {
    const calls: string[] = []
    const rootRuntime: RootRuntimeManager = {
      async restore() {
        return { restoredCount: 0 }
      },
      async emitRuntimeEvent() {},
      async ingestGroupMessage() {
        calls.push('ingest')
      },
      async primeGroupCursor(input) {
        calls.push(`prime:${input.lastObservedMessageRowId}`)
      },
      requeuePendingPassiveMentions() {
        calls.push('requeue')
        return 0
      },
      async markPassiveReplyDelivered() {},
      dispatchPassiveMentionIfMentioned() {
        calls.push('dispatch')
        return false
      },
      getSnapshot() {
        return null
      },
      enqueuePassiveMention() {},
      startPassiveExecution() {},
      stopPassiveExecution() {},
    }

    await replayPersistedRootRuntimeDelta({
      groupIds: [1],
      rootRuntime,
      getLatestMessageRowId: async (groupId) => {
        assert.equal(groupId, 1)
        return 120
      },
      getMessagesAfterRowId: async () => {
        throw new Error('should not replay history without snapshot')
      },
    })

    assert.deepEqual(calls, ['prime:120'])
  })
})

describe('recoverStartupAndStartPassiveRuntime', () => {
  test('starts passive execution only after recoverable assistant turns are replayed', async () => {
    const calls: string[] = []
    const rootRuntime: RootRuntimeManager = {
      async restore() {
        return { restoredCount: 0 }
      },
      async emitRuntimeEvent() {},
      async ingestGroupMessage() {},
      async primeGroupCursor() {},
      requeuePendingPassiveMentions() {
        calls.push('requeue')
        return 1
      },
      async markPassiveReplyDelivered(input) {
        calls.push(`mark:${input.incorporatedMessageRowId}`)
      },
      dispatchPassiveMentionIfMentioned() {
        return false
      },
      getSnapshot() {
        return null
      },
      enqueuePassiveMention() {},
      startPassiveExecution() {
        calls.push('start-passive')
      },
      stopPassiveExecution() {},
    }

    await recoverStartupAndStartPassiveRuntime({
      groupIds: [1],
      rootRuntime,
      migrateLegacyAssistantTurnsFn: async () => {
        calls.push('migrate')
        return { migratedCount: 0, projectedSentCount: 0 }
      },
      recoverReplyRecordStartupStateFn: async (options) => {
        calls.push('recover:start')
        await options.onReplyRecordRecovered?.({
          id: 7,
          runtimeKey: 'qq_group:1',
          groupId: 1,
          scopeKey: 'sender:20',
          replyIntentId: 'intent-1',
          sourceKind: 'mention',
          triggerMessageRowId: 4,
          incorporatedMessageRowId: 5,
          deliveryPayload: {
            type: 'reply_to_message',
            replyToMessageId: 2001,
            mentionUserId: 20,
          },
          text: '恢复发送的回复',
          executionState: 'sent',
          providerMessageId: undefined,
          attemptCount: 1,
          createdAt: new Date('2026-04-21T00:00:00Z'),
          updatedAt: new Date('2026-04-21T00:00:00Z'),
        })
        calls.push('recover:end')

        return {
          recoveredReplyRecords: 1,
          failedReplyRecords: 0,
        }
      },
    })

    assert.deepEqual(calls, [
      'migrate',
      'recover:start',
      'mark:5',
      'recover:end',
      'requeue',
      'start-passive',
    ])
  })
})

describe('startRuntimeSchedulerTicks', () => {
  test('emits scheduler_tick runtime events for each group and can be stopped', async () => {
    const events: string[] = []
    const rootRuntime: RootRuntimeManager = {
      async restore() {
        return { restoredCount: 0 }
      },
      async emitRuntimeEvent(event) {
        events.push(`${event.eventKind}:${event.groupId}:${event.createdAt.toISOString()}`)
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
    }

    const timer = startRuntimeSchedulerTicks({
      groupIds: [1, 2],
      rootRuntime,
      intervalMs: 1,
      now: () => new Date('2026-04-22T00:00:00Z'),
    })
    assert.ok(timer)
    await new Promise((resolve) => setTimeout(resolve, 5))
    clearInterval(timer)

    assert.ok(events.includes('scheduler_tick:1:2026-04-22T00:00:00.000Z'))
    assert.ok(events.includes('scheduler_tick:2:2026-04-22T00:00:00.000Z'))
  })

  test('does not start when interval is disabled', () => {
    const timer = startRuntimeSchedulerTicks({
      groupIds: [1],
      rootRuntime: {} as RootRuntimeManager,
      intervalMs: 0,
    })

    assert.equal(timer, null)
  })
})
