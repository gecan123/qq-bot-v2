import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Message } from '../generated/prisma/client.js'
import { ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION } from '../runtime/types.js'
import { buildContext } from './context-builder.js'
import { buildReplyHistory } from './reply-history.js'
import { buildSystemPrompt } from './agent-session.js'
import { loadPrompt } from '../config/prompt-loader.js'
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

type PromptEnvelope = {
  contextText: string
  history: ReturnType<typeof buildReplyHistory>
  systemPrompt: string
}

async function buildPromptEnvelope(dependencies: Parameters<typeof buildContext>[3]): Promise<PromptEnvelope> {
  const msg = {
    groupId: 1,
    messageId: 1001,
    senderId: 20,
    senderNickname: '用户20',
    segments: [{ type: 'text' as const, content: '@bot 你好' }],
  }
  const { contextText } = await buildContext(
    msg,
    20,
    {},
    dependencies,
  )
  const history = buildReplyHistory(contextText, '@bot 你好')
  const systemPrompt = buildSystemPrompt('你是测试助手', loadPrompt('./prompts/reply-instruction.md'))

  return {
    contextText,
    history,
    systemPrompt,
  }
}

function diffLines(left: string, right: string): Array<{ index: number; snapshot?: string; fallback?: string }> {
  const leftLines = left.split('\n')
  const rightLines = right.split('\n')
  const maxLines = Math.max(leftLines.length, rightLines.length)
  const diffs: Array<{ index: number; snapshot?: string; fallback?: string }> = []

  for (let index = 0; index < maxLines; index++) {
    const snapshotLine = leftLines[index]
    const fallbackLine = rightLines[index]
    if (snapshotLine !== fallbackLine) {
      diffs.push({
        index,
        ...(snapshotLine !== undefined ? { snapshot: snapshotLine } : {}),
        ...(fallbackLine !== undefined ? { fallback: fallbackLine } : {}),
      })
    }
  }

  return diffs
}

function serializeHistory(history: PromptEnvelope['history']): string {
  return history
    .flatMap((message) => {
      if (message.role === 'user' || message.role === 'model') {
        return [`${message.role}:${message.content}`]
      }
      return []
    })
    .join('\n')
}

describe('prompt parity harness', () => {
  test('matches snapshot path and ledger rebuild path after prompt authority cutover', async () => {
    const sharedDeps = {
      getConversationState: async () => ({
        id: 1,
        groupId: 1,
        senderThreadKey: 'sender:20',
        compactedBase: '旧压缩',
        compactedVersion: 1,
        lastCompactedMessageRowId: undefined,
        createdAt: new Date('2026-04-22T00:00:00Z'),
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      }),
      getLatestSentTurn: async () =>
        makeReplyRecord({
          id: 1,
          triggerMessageRowId: 11,
          incorporatedMessageRowId: 11,
          text: '好的',
          createdAt: new Date('2026-04-22T00:01:30Z'),
          updatedAt: new Date('2026-04-22T00:01:30Z'),
        }),
      getStoredMessage: async (_groupId: number, messageId: number) =>
        makeMessage({ id: 10, messageId: BigInt(messageId), resolvedText: '@bot 你好' }),
    }

    const snapshotEnvelope = await buildPromptEnvelope({
      ...sharedDeps,
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
              senderId: 20,
              content: '[QQ消息]\n用户20: 新消息',
            },
            {
              role: 'model',
              kind: 'assistant_turn',
              orderKey: 11,
              senderId: 20,
              content: '好的',
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
          proactiveCandidates: [],
          recentObservedMessageRowIds: [11],
          lastWakeAt: null,
        },
        lastObservedMessageRowId: 11,
        createdAt: new Date('2026-04-22T00:00:00Z'),
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      }),
    })

    const fallbackEnvelope = await buildPromptEnvelope({
      ...sharedDeps,
      getRuntimeSnapshot: async () => null,
      getRecentMessages: async () => [
        makeMessage({
          id: 11,
          senderNickname: '用户20',
          resolvedText: '新消息',
          createdAt: new Date('2026-04-22T00:01:00Z'),
        }),
      ],
      listReplyRecords: async () => [
        makeReplyRecord({
          id: 1,
          triggerMessageRowId: 11,
          incorporatedMessageRowId: 11,
          text: '好的',
          createdAt: new Date('2026-04-22T00:01:30Z'),
          updatedAt: new Date('2026-04-22T00:01:30Z'),
        }),
      ],
    })

    const report = {
      snapshot: snapshotEnvelope,
      fallback: fallbackEnvelope,
      parity: {
        systemPromptExact: snapshotEnvelope.systemPrompt === fallbackEnvelope.systemPrompt,
        currentTurnExact:
          serializeHistory(snapshotEnvelope.history.slice(1)) === serializeHistory(fallbackEnvelope.history.slice(1)),
        contextExact: snapshotEnvelope.contextText === fallbackEnvelope.contextText,
        historyExact: JSON.stringify(snapshotEnvelope.history) === JSON.stringify(fallbackEnvelope.history),
      },
      diff: {
        contextLines: diffLines(snapshotEnvelope.contextText, fallbackEnvelope.contextText),
        historyTurns: diffLines(serializeHistory(snapshotEnvelope.history), serializeHistory(fallbackEnvelope.history)),
      },
    }

    assert.equal(report.parity.systemPromptExact, true)
    assert.equal(report.parity.currentTurnExact, true)
    assert.equal(report.parity.contextExact, true)
    assert.equal(report.parity.historyExact, true)
    assert.deepEqual(report.diff.contextLines, [])
    assert.deepEqual(report.diff.historyTurns, [])
  })

  test('retains shared compacted and quote context across both prompt envelopes', async () => {
    const msg = {
      groupId: 1,
      messageId: 1001,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'reply' as const, messageId: '42' }, { type: 'text' as const, content: '@bot 你好' }],
    }

    const sharedDeps = {
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
      getLatestSentTurn: async () => null,
      getStoredMessage: async (_groupId: number, messageId: number) =>
        makeMessage({
          id: messageId === 1001 ? 11 : 42,
          messageId: BigInt(messageId),
          senderNickname: messageId === 42 ? '用户A' : '用户20',
          resolvedText: messageId === 42 ? '被引用内容' : '@bot 你好',
          createdAt: new Date('2026-04-22T00:00:00Z'),
        }),
    }

    const snapshot = await buildContext(
      msg,
      20,
      {},
      {
        ...sharedDeps,
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
            proactiveCandidates: [],
            recentObservedMessageRowIds: [11],
            lastWakeAt: null,
          },
          lastObservedMessageRowId: 11,
          createdAt: new Date('2026-04-22T00:00:00Z'),
          updatedAt: new Date('2026-04-22T00:00:00Z'),
        }),
      },
    )

    const fallback = await buildContext(
      msg,
      20,
      {},
      {
        ...sharedDeps,
        getRuntimeSnapshot: async () => null,
        getMessagesAfterRowId: async () => [
          makeMessage({
            id: 11,
            senderNickname: '用户20',
            resolvedText: 'keep',
            createdAt: new Date('2026-04-22T00:01:00Z'),
          }),
        ],
        listReplyRecordsAfterRowId: async () => [],
      },
    )

    assert.match(snapshot.contextText, /\[压缩上下文\]\n已压缩前缀/)
    assert.match(fallback.contextText, /\[压缩上下文\]\n已压缩前缀/)
    assert.match(snapshot.contextText, /\[被引用消息\] 用户A: 被引用内容/)
    assert.match(fallback.contextText, /\[被引用消息\] 用户A: 被引用内容/)
  })
})
