import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Message } from '../generated/prisma/client.js'
import { buildContext } from './context-builder.js'
import { ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION } from '../runtime/types.js'
import type { ReplyRecord } from '../conversation/reply-record-store.js'

function makeMessage(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    id: overrides.id,
    groupId: overrides.groupId ?? BigInt(1),
    groupName: overrides.groupName ?? '测试群',
    mediaReferenceIds: overrides.mediaReferenceIds ?? [],
    messageId: overrides.messageId ?? BigInt(overrides.id),
    senderId: overrides.senderId ?? BigInt(20),
    senderNickname: overrides.senderNickname ?? '用户20',
    senderGroupNickname: overrides.senderGroupNickname ?? null,
    content: overrides.content ?? [],
    rawContent: overrides.rawContent ?? null,
    rawMessage: overrides.rawMessage ?? null,
    searchText: overrides.searchText ?? '',
    resolvedText: overrides.resolvedText ?? null,
    sentAt: overrides.sentAt ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-04-22T00:00:00Z'),
  }
}

function makeReplyRecord(overrides: Partial<ReplyRecord> & Pick<ReplyRecord, 'id'>): ReplyRecord {
  return {
    id: overrides.id,
    runtimeKey: overrides.runtimeKey ?? 'qq_group:1',
    groupId: overrides.groupId ?? 1,
    scopeKey: overrides.scopeKey ?? 'sender:20',
    replyIntentId: overrides.replyIntentId ?? `intent-${overrides.id}`,
    sourceKind: overrides.sourceKind ?? 'mention',
    triggerMessageRowId: overrides.triggerMessageRowId ?? overrides.id,
    incorporatedMessageRowId: overrides.incorporatedMessageRowId ?? overrides.id,
    deliveryPayload:
      overrides.deliveryPayload ?? { type: 'reply_to_message', replyToMessageId: 1000 + overrides.id, mentionUserId: 20 },
    text: overrides.text ?? 'reply',
    executionState: overrides.executionState ?? 'sent',
    providerMessageId: overrides.providerMessageId ?? 9000 + overrides.id,
    attemptCount: overrides.attemptCount ?? 1,
    createdAt: overrides.createdAt ?? new Date('2026-04-22T00:01:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-04-22T00:01:00Z'),
  }
}

describe('buildContext', () => {
  test('prefers root runtime snapshot context when available', async () => {
    const result = await buildContext(
      {
        groupId: 1,
        messageId: 1001,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '@bot 你好' }],
      },
      20,
      {},
      {
        getConversationState: async () => ({
          id: 1,
          groupId: 1,
          senderThreadKey: 'sender:20',
          compactedBase: '旧压缩',
          compactedVersion: 1,
          lastCompactedMessageRowId: 10,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getStoredMessage: async (_groupId, messageId) =>
          makeMessage({ id: 10, messageId: BigInt(messageId), resolvedText: '@bot 你好' }),
        getLatestSentTurn: async () =>
          makeReplyRecord({
            id: 1,
            triggerMessageRowId: 10,
            incorporatedMessageRowId: 10,
            text: '你好',
            createdAt: new Date('2026-04-22T00:00:30Z'),
            updatedAt: new Date('2026-04-22T00:00:30Z'),
          }),
        getRuntimeSnapshot: async () => ({
          id: 1,
          runtimeKey: 'qq_group:1',
          groupId: 1,
          schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: {
            messages: [
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 11,
                senderId: 30,
                content: '[QQ消息]\n用户A: 早上好',
              },
              {
                role: 'model',
                kind: 'assistant_turn',
                orderKey: 11,
                senderId: 20,
                content: '你好',
              },
            ],
          },
          sessionSnapshot: {
            focusedStateId: 'qq_group:1',
            stateStack: ['qq_group:1'],
            unreadMessages: [],
            senderContinuities: [
              {
                senderThreadKey: 'sender:20',
                senderId: 20,
                lastSeenMessageRowId: 10,
                lastMaterializedMessageRowId: 10,
                updatedAt: '2026-04-22T00:00:00.000Z',
              },
            ],
            ambientAuditCandidates: [],
            recentObservedMessageRowIds: [10],
            lastWakeAt: null,
          },
          lastObservedMessageRowId: 10,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
      },
    )

    assert.equal(
      result.contextText,
      '[压缩上下文]\n旧压缩\n\n[QQ消息]\n用户A: 早上好\n[BOT] 你好',
    )
    assert.deepEqual(result.recentMessages, [])
  })

  test('uses ledger rebuild when runtime context fallback is ledger', async () => {
    const result = await buildContext(
      {
        groupId: 1,
        messageId: 1001,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '@bot 你好' }],
      },
      20,
      { runtimeContextFallback: 'ledger' },
      {
        getConversationState: async () => ({
          id: 1,
          groupId: 1,
          senderThreadKey: 'sender:20',
          compactedBase: '',
          compactedVersion: 1,
          lastCompactedMessageRowId: undefined,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getStoredMessage: async (_groupId, messageId) =>
          makeMessage({ id: 10, messageId: BigInt(messageId), resolvedText: '@bot 你好' }),
        getLatestSentTurn: async () => null,
        getRuntimeSnapshot: async () => ({
          id: 1,
          runtimeKey: 'qq_group:1',
          groupId: 1,
          schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: {
            messages: [{ role: 'user', kind: 'group_message', orderKey: 10, senderId: 20, content: '[QQ消息]\n用户20: snapshot path' }],
          },
          sessionSnapshot: {
            focusedStateId: 'qq_group:1',
            stateStack: ['qq_group:1'],
            unreadMessages: [],
            senderContinuities: [],
            ambientAuditCandidates: [],
            recentObservedMessageRowIds: [10],
            lastWakeAt: null,
          },
          lastObservedMessageRowId: 10,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getRecentMessages: async () => [makeMessage({ id: 10, messageId: BigInt(1001), resolvedText: 'ledger path' })],
        listReplyRecords: async () => [],
      },
    )

    assert.equal(result.contextText, '[QQ消息]\n用户20: ledger path')
  })

  test('rebuilds runtime-native context when runtime snapshot has not observed current trigger message yet', async () => {
    const result = await buildContext(
      {
        groupId: 1,
        messageId: 1001,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '@bot 你好' }],
      },
      20,
      {},
      {
        getConversationState: async () => ({
          id: 1,
          groupId: 1,
          senderThreadKey: 'sender:20',
          compactedBase: '',
          compactedVersion: 1,
          lastCompactedMessageRowId: undefined,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getStoredMessage: async (_groupId, messageId) =>
          makeMessage({ id: 11, messageId: BigInt(messageId), resolvedText: '@bot 你好' }),
        getLatestSentTurn: async () => null,
        getRuntimeSnapshot: async () => ({
          id: 1,
          runtimeKey: 'qq_group:1',
          groupId: 1,
          schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: {
            messages: [
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 10,
                senderId: 30,
                content: '[QQ消息]\n用户A: 旧上下文',
              },
            ],
          },
          sessionSnapshot: {
            focusedStateId: 'qq_group:1',
            stateStack: ['qq_group:1'],
            unreadMessages: [],
            senderContinuities: [
              {
                senderThreadKey: 'sender:20',
                senderId: 20,
                lastSeenMessageRowId: 10,
                lastMaterializedMessageRowId: 10,
                updatedAt: '2026-04-22T00:00:00.000Z',
              },
            ],
            ambientAuditCandidates: [],
            recentObservedMessageRowIds: [10],
            lastWakeAt: null,
          },
          lastObservedMessageRowId: 10,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getRecentMessages: async () => [
          makeMessage({
            id: 2,
            senderNickname: '用户A',
            resolvedText: 'fallback path',
          }),
        ],
        listReplyRecords: async () => [],
      },
    )

    assert.equal(result.contextText, '[QQ消息]\n用户A: fallback path')
    assert.equal(result.recentMessages.length, 1)
  })

  test('rebuilds runtime-native context from ledgers when runtime snapshot is unavailable', async () => {
    const result = await buildContext(
      {
        groupId: 1,
        messageId: 1001,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '@bot 你好' }],
      },
      20,
      {},
      {
        getConversationState: async () => ({
          id: 1,
          groupId: 1,
          senderThreadKey: 'sender:20',
          compactedBase: '',
          compactedVersion: 1,
          lastCompactedMessageRowId: undefined,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getLatestSentTurn: async () =>
          makeReplyRecord({
            id: 1,
            triggerMessageRowId: 1,
            incorporatedMessageRowId: 1,
            deliveryPayload: { type: 'reply_to_message', replyToMessageId: 1, mentionUserId: 20 },
            text: 'reply',
          }),
        getRuntimeSnapshot: async () => null,
        getRecentMessages: async () => [
          makeMessage({
            id: 1,
            senderNickname: '用户A',
            resolvedText: 'hello',
          }),
        ],
        listReplyRecords: async () => [
          makeReplyRecord({
            id: 1,
            triggerMessageRowId: 1,
            incorporatedMessageRowId: 1,
            deliveryPayload: { type: 'reply_to_message', replyToMessageId: 1, mentionUserId: 20 },
            text: 'reply',
          }),
        ],
      },
    )

    assert.equal(result.contextText, '[QQ消息]\n用户A: hello\n[BOT] reply')
    assert.equal(result.recentMessages.length, 1)
  })

  test('renders runtime snapshot context in stable order even when stored entries are unsorted', async () => {
    const result = await buildContext(
      {
        groupId: 1,
        messageId: 1001,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '@bot 你好' }],
      },
      20,
      {},
      {
        getConversationState: async () => ({
          id: 1,
          groupId: 1,
          senderThreadKey: 'sender:20',
          compactedBase: '',
          compactedVersion: 1,
          lastCompactedMessageRowId: undefined,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getStoredMessage: async (_groupId, messageId) =>
          makeMessage({ id: 10, messageId: BigInt(messageId), resolvedText: '@bot 你好' }),
        getLatestSentTurn: async () =>
          makeReplyRecord({
            id: 1,
            triggerMessageRowId: 10,
            incorporatedMessageRowId: 10,
            text: 'reply newer',
            createdAt: new Date('2026-04-22T00:00:30Z'),
            updatedAt: new Date('2026-04-22T00:00:30Z'),
          }),
        getRuntimeSnapshot: async () => ({
          id: 1,
          runtimeKey: 'qq_group:1',
          groupId: 1,
          schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: {
            messages: [
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 10,
                senderId: 20,
                content: '[QQ消息]\n用户20: newer',
              },
              {
                role: 'model',
                kind: 'assistant_turn',
                orderKey: 10,
                senderId: 20,
                content: 'reply newer',
              },
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 9,
                senderId: 20,
                content: '[QQ消息]\n用户20: older',
              },
            ],
          },
          sessionSnapshot: {
            focusedStateId: 'qq_group:1',
            stateStack: ['qq_group:1'],
            unreadMessages: [],
            senderContinuities: [
              {
                senderThreadKey: 'sender:20',
                senderId: 20,
                lastSeenMessageRowId: 10,
                lastMaterializedMessageRowId: 10,
                updatedAt: '2026-04-22T00:00:00.000Z',
              },
            ],
            ambientAuditCandidates: [],
            recentObservedMessageRowIds: [9, 10],
            lastWakeAt: null,
          },
          lastObservedMessageRowId: 10,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
      },
    )

    assert.equal(
      result.contextText,
      '[QQ消息]\n用户20: older\n[QQ消息]\n用户20: newer\n[BOT] reply newer',
    )
  })

  test('applies replyContextMessages limit on runtime snapshot path', async () => {
    const result = await buildContext(
      {
        groupId: 1,
        messageId: 1001,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '@bot 你好' }],
      },
      2,
      {},
      {
        getConversationState: async () => ({
          id: 1,
          groupId: 1,
          senderThreadKey: 'sender:20',
          compactedBase: '',
          compactedVersion: 1,
          lastCompactedMessageRowId: undefined,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getStoredMessage: async (_groupId, messageId) =>
          makeMessage({ id: 12, messageId: BigInt(messageId), resolvedText: '@bot 你好' }),
        getLatestSentTurn: async () =>
          makeReplyRecord({
            id: 1,
            triggerMessageRowId: 11,
            incorporatedMessageRowId: 11,
            text: 'reply keep-1',
            createdAt: new Date('2026-04-22T00:00:30Z'),
            updatedAt: new Date('2026-04-22T00:00:30Z'),
          }),
        getRuntimeSnapshot: async () => ({
          id: 1,
          runtimeKey: 'qq_group:1',
          groupId: 1,
          schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: {
            messages: [
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 10,
                senderId: 20,
                content: '[QQ消息]\n用户20: old-1',
              },
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 11,
                senderId: 20,
                content: '[QQ消息]\n用户20: keep-1',
              },
              {
                role: 'model',
                kind: 'assistant_turn',
                orderKey: 11,
                senderId: 20,
                content: 'reply keep-1',
              },
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 12,
                senderId: 20,
                content: '[QQ消息]\n用户20: keep-2',
              },
            ],
          },
          sessionSnapshot: {
            focusedStateId: 'qq_group:1',
            stateStack: ['qq_group:1'],
            unreadMessages: [],
            senderContinuities: [
              {
                senderThreadKey: 'sender:20',
                senderId: 20,
                lastSeenMessageRowId: 12,
                lastMaterializedMessageRowId: 12,
                updatedAt: '2026-04-22T00:00:00.000Z',
              },
            ],
            ambientAuditCandidates: [],
            recentObservedMessageRowIds: [10, 11, 12],
            lastWakeAt: null,
          },
          lastObservedMessageRowId: 12,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
      },
    )

    assert.equal(
      result.contextText,
      '[QQ消息]\n用户20: keep-1\n[BOT] reply keep-1\n[QQ消息]\n用户20: keep-2',
    )
  })

  test('does not re-emit runtime snapshot entries that are already compacted into compactedBase', async () => {
    const result = await buildContext(
      {
        groupId: 1,
        messageId: 1001,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '@bot 你好' }],
      },
      20,
      {},
      {
        getConversationState: async () => ({
          id: 1,
          groupId: 1,
          senderThreadKey: 'sender:20',
          compactedBase: '已压缩前缀',
          compactedVersion: 1,
          lastCompactedMessageRowId: 10,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getStoredMessage: async (_groupId, messageId) =>
          makeMessage({ id: 11, messageId: BigInt(messageId), resolvedText: '@bot 你好' }),
        getLatestSentTurn: async () => null,
        getRuntimeSnapshot: async () => ({
          id: 1,
          runtimeKey: 'qq_group:1',
          groupId: 1,
          schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: {
            messages: [
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 9,
                senderId: 20,
                content: '[QQ消息]\n用户20: old-1',
              },
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 10,
                senderId: 20,
                content: '[QQ消息]\n用户20: old-2',
              },
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 11,
                senderId: 20,
                content: '[QQ消息]\n用户20: keep',
              },
            ],
          },
          sessionSnapshot: {
            focusedStateId: 'qq_group:1',
            stateStack: ['qq_group:1'],
            unreadMessages: [],
            senderContinuities: [
              {
                senderThreadKey: 'sender:20',
                senderId: 20,
                lastSeenMessageRowId: 11,
                lastMaterializedMessageRowId: 11,
                updatedAt: '2026-04-22T00:00:00.000Z',
              },
            ],
            ambientAuditCandidates: [],
            recentObservedMessageRowIds: [9, 10, 11],
            lastWakeAt: null,
          },
          lastObservedMessageRowId: 11,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
      },
    )

    assert.equal(result.contextText, '[压缩上下文]\n已压缩前缀\n\n[QQ消息]\n用户20: keep')
  })

  test('filters runtime snapshot assistant turns to the current sender thread', async () => {
    const result = await buildContext(
      {
        groupId: 1,
        messageId: 1001,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '@bot 你好' }],
      },
      20,
      {},
      {
        getConversationState: async () => ({
          id: 1,
          groupId: 1,
          senderThreadKey: 'sender:20',
          compactedBase: '',
          compactedVersion: 1,
          lastCompactedMessageRowId: undefined,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getStoredMessage: async (_groupId, messageId) =>
          makeMessage({ id: 10, messageId: BigInt(messageId), resolvedText: '@bot 你好' }),
        getLatestSentTurn: async () =>
          makeReplyRecord({
            id: 1,
            triggerMessageRowId: 9,
            incorporatedMessageRowId: 9,
            text: 'reply-to-20',
            createdAt: new Date('2026-04-22T00:00:30Z'),
            updatedAt: new Date('2026-04-22T00:00:30Z'),
          }),
        getRuntimeSnapshot: async () => ({
          id: 1,
          runtimeKey: 'qq_group:1',
          groupId: 1,
          schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: {
            messages: [
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 9,
                senderId: 30,
                content: '[QQ消息]\n用户A: hello',
              },
              {
                role: 'model',
                kind: 'assistant_turn',
                orderKey: 9,
                senderId: 20,
                content: 'reply-to-20',
              },
              {
                role: 'model',
                kind: 'assistant_turn',
                orderKey: 10,
                senderId: 30,
                content: 'reply-to-30',
              },
            ],
          },
          sessionSnapshot: {
            focusedStateId: 'qq_group:1',
            stateStack: ['qq_group:1'],
            unreadMessages: [],
            senderContinuities: [
              {
                senderThreadKey: 'sender:20',
                senderId: 20,
                lastSeenMessageRowId: 10,
                lastMaterializedMessageRowId: 9,
                updatedAt: '2026-04-22T00:00:00.000Z',
              },
            ],
            ambientAuditCandidates: [],
            recentObservedMessageRowIds: [10],
            lastWakeAt: null,
          },
          lastObservedMessageRowId: 10,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
      },
    )

    assert.equal(result.contextText, '[QQ消息]\n用户A: hello\n[BOT] reply-to-20')
  })

  test('falls back to ledger rebuild when snapshot lags behind latest sent assistant turn', async () => {
    const result = await buildContext(
      {
        groupId: 1,
        messageId: 1001,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '@bot 继续' }],
      },
      20,
      {},
      {
        getConversationState: async () => ({
          id: 1,
          groupId: 1,
          senderThreadKey: 'sender:20',
          compactedBase: '',
          compactedVersion: 1,
          lastCompactedMessageRowId: undefined,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getStoredMessage: async (_groupId, messageId) =>
          makeMessage({ id: 16, messageId: BigInt(messageId), resolvedText: '@bot 继续' }),
        getLatestSentTurn: async () =>
          makeReplyRecord({
            id: 2,
            triggerMessageRowId: 15,
            incorporatedMessageRowId: 15,
            deliveryPayload: { type: 'reply_to_message', replyToMessageId: 1002, mentionUserId: 20 },
            text: '最新 bot 回复',
            createdAt: new Date('2026-04-22T00:02:00Z'),
            updatedAt: new Date('2026-04-22T00:02:00Z'),
          }),
        getRuntimeSnapshot: async () => ({
          id: 1,
          runtimeKey: 'qq_group:1',
          groupId: 1,
          schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: {
            messages: [
              {
                role: 'user',
                kind: 'group_message',
                orderKey: 15,
                senderId: 20,
                content: '[QQ消息]\n用户20: 旧用户消息',
              },
            ],
          },
          sessionSnapshot: {
            focusedStateId: 'qq_group:1',
            stateStack: ['qq_group:1'],
            unreadMessages: [],
            senderContinuities: [
              {
                senderThreadKey: 'sender:20',
                senderId: 20,
                lastSeenMessageRowId: 16,
                lastMaterializedMessageRowId: 14,
                updatedAt: '2026-04-22T00:00:00.000Z',
              },
            ],
            ambientAuditCandidates: [],
            recentObservedMessageRowIds: [15, 16],
            lastWakeAt: null,
          },
          lastObservedMessageRowId: 16,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
        getRecentMessages: async () => [
          makeMessage({
            id: 15,
            messageId: BigInt(1002),
            senderId: BigInt(20),
            senderNickname: '用户20',
            resolvedText: '旧用户消息',
          }),
        ],
        listReplyRecords: async () => [
          makeReplyRecord({
            id: 2,
            triggerMessageRowId: 15,
            incorporatedMessageRowId: 15,
            deliveryPayload: { type: 'reply_to_message', replyToMessageId: 1002, mentionUserId: 20 },
            text: '最新 bot 回复',
            createdAt: new Date('2026-04-22T00:02:00Z'),
            updatedAt: new Date('2026-04-22T00:02:00Z'),
          }),
        ],
      },
    )

    assert.equal(result.contextText, '[QQ消息]\n用户20: 旧用户消息\n[BOT] 最新 bot 回复')
    assert.equal(result.recentMessages.length, 1)
  })
})
