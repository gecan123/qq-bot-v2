import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { recoverStartupAndStartPassiveRuntime, replayPersistedRootRuntimeDelta } from './index.js'
import type { RootRuntimeManager, PersistedGroupMessageIngress } from './runtime/root-runtime.js'
import type { ParsedSegment } from './types/message-segments.js'

describe('replayPersistedRootRuntimeDelta', () => {
  test('replays persisted mentions back into passive runtime queue during startup recovery', async () => {
    const calls: string[] = []
    const rootRuntime: RootRuntimeManager = {
      async restore() {
        return { restoredCount: 0 }
      },
      async ingestGroupMessage(input: PersistedGroupMessageIngress) {
        calls.push(`ingest:${input.messageRowId}`)
      },
      async primeGroupCursor(input) {
        calls.push(`prime:${input.lastObservedMessageRowId}`)
      },
      async markPassiveReplyDelivered() {},
      dispatchPassiveMentionIfMentioned(input: {
        groupId: number
        messageId: number
        senderId: number
        createdAt: number
        segments: ParsedSegment[]
      }) {
        calls.push(`dispatch:${input.messageId}`)
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
      'dispatch:1001',
      'ingest:11',
      'dispatch:1002',
      'ingest:12',
    ])
  })

  test('primes cursor instead of replaying full history when no snapshot exists', async () => {
    const calls: string[] = []
    const rootRuntime: RootRuntimeManager = {
      async restore() {
        return { restoredCount: 0 }
      },
      async ingestGroupMessage() {
        calls.push('ingest')
      },
      async primeGroupCursor(input) {
        calls.push(`prime:${input.lastObservedMessageRowId}`)
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
      async ingestGroupMessage() {},
      async primeGroupCursor() {},
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
      recoverConversationStartupStateFn: async (options) => {
        calls.push('recover:start')
        await options.onAssistantTurnRecovered?.({
          id: 7,
          groupId: 1,
          senderThreadKey: 'sender:20',
          replyIntentId: 'intent-1',
          triggerMessageRowId: 4,
          incorporatedMessageRowId: 5,
          sequence: 1,
          replyToMessageId: 2001,
          mentionUserId: 20,
          text: '恢复发送的回复',
          status: 'sent',
          attemptCount: 1,
          createdAt: new Date('2026-04-21T00:00:00Z'),
          updatedAt: new Date('2026-04-21T00:00:00Z'),
        })
        calls.push('recover:end')

        return {
          recoveredAssistantTurns: 1,
          failedAssistantTurns: 0,
          enqueuedMentions: 0,
        }
      },
    })

    assert.deepEqual(calls, [
      'recover:start',
      'mark:5',
      'recover:end',
      'start-passive',
    ])
  })
})
