import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Message } from '../generated/prisma/client.js'
import type { AgentMessage } from '../agent/types.js'
import type { ConversationSummarizer } from './summarizer.js'
import { compactConversationIfNeeded } from './compaction.js'

function makeMessage(id: number, overrides: Partial<Message> = {}): Message {
  return {
    id,
    sceneKind: 'qq_group',
    sceneExternalId: '1',
    groupId: BigInt(1),
    groupName: '测试群',
    mediaReferenceIds: [],
    messageId: BigInt(1000 + id),
    senderId: BigInt(200 + id),
    senderNickname: `用户${id}`,
    senderGroupNickname: null,
    content: [{ type: 'text', content: `原始文本${id}` }] as Message['content'],
    rawContent: null,
    rawMessage: null,
    searchText: `原始文本${id}`,
    resolvedText: `原始文本${id}`,
    sentAt: new Date(`2026-04-21T00:${String(id % 60).padStart(2, '0')}:00Z`),
    createdAt: new Date(`2026-04-21T00:${String(id % 60).padStart(2, '0')}:00Z`),
    ...overrides,
  }
}

function makeMockSummarizer(opts: {
  output: string
  capture?: { calls: Array<{ previousSummary: string | null; historyToCompress: AgentMessage[] }> }
}): ConversationSummarizer {
  return {
    async summarize(input) {
      opts.capture?.calls.push(input)
      return opts.output
    },
  }
}

// 测试用旧阈值 (40/12) 让现有 41 条 message case 仍能 trigger compaction
const TEST_DEPS_LEGACY_THRESHOLDS = { triggerThreshold: 40, keepRecentCount: 12 } as const

describe('conversation compaction (Phase 1.5)', () => {
  test('compaction freezes unresolved text before invoking summarizer', async () => {
    const frozenWrites: Array<{ id: number; text: string }> = []
    const resolveCalls: number[] = []
    const savedStates: Array<{ compactedBase: string; lastCompactedMessageRowId: number }> = []
    const summarizerCalls: Array<{ previousSummary: string | null; historyToCompress: AgentMessage[] }> = []

    const messages = Array.from({ length: 41 }, (_, index) => {
      const id = index + 1
      if (id === 1) {
        return makeMessage(id, {
          mediaReferenceIds: ['77'],
          content: [{ type: 'video', referenceId: '77' }] as Message['content'],
          resolvedText: null,
          searchText: '[视频]',
        })
      }

      if (id === 2) {
        return makeMessage(id, {
          resolvedText: '已冻结文本',
          searchText: '已冻结文本',
        })
      }

      return makeMessage(id)
    })

    await compactConversationIfNeeded(1, 'qq_group:1', {
      ...TEST_DEPS_LEGACY_THRESHOLDS,
      getConversationState: async () => ({
        id: 1,
        groupId: 1,
        senderThreadKey: 'qq_group:1',
        compactedBase: '',
        compactedVersion: 1,
        lastCompactedMessageRowId: undefined,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      getMessagesAfterRowId: async () => messages,
      getActionRecordsForScene: async () => [],
      resolveConversationMessage: async (message) => {
        resolveCalls.push(message.id)
        if (message.id === 1) {
          return [{ type: 'text', content: '解析后的媒体文本' }]
        }
        return message.content as any
      },
      freezeResolvedText: async (id, text) => {
        frozenWrites.push({ id, text })
      },
      saveCompactedState: async (params) => {
        savedStates.push({
          compactedBase: params.compactedBase,
          lastCompactedMessageRowId: params.lastCompactedMessageRowId,
        })
      },
      summarizer: makeMockSummarizer({
        output: 'LLM 摘要: 群里聊了 41 条消息, 有视频和文本',
        capture: { calls: summarizerCalls },
      }),
    })

    // freezeResolvedText 仍然在 compaction 内部跑 (媒体解析行为不变)
    assert.deepEqual(resolveCalls, [1])
    assert.deepEqual(frozenWrites, [{ id: 1, text: '解析后的媒体文本' }])

    // compactedBase 是 LLM 摘要 (不是文本拼接)
    assert.equal(savedStates.length, 1)
    assert.equal(savedStates[0]?.compactedBase, 'LLM 摘要: 群里聊了 41 条消息, 有视频和文本')
    assert.equal(savedStates[0]?.lastCompactedMessageRowId, 29)

    // summarizer 收到的 historyToCompress 是真多轮, 包含解析后的媒体文本
    assert.equal(summarizerCalls.length, 1)
    const sentToSummarizer = summarizerCalls[0]?.historyToCompress ?? []
    assert.ok(sentToSummarizer.length > 0)
    const allContent = sentToSummarizer
      .map((m) => 'content' in m ? m.content : '')
      .join('|')
    assert.match(allContent, /解析后的媒体文本/)
    assert.match(allContent, /已冻结文本/)
    assert.doesNotMatch(allContent, /\[视频\]/)
  })

  test('已 sent action_records 作为 model role 进 summarizer', async () => {
    const summarizerCalls: Array<{ previousSummary: string | null; historyToCompress: AgentMessage[] }> = []
    const savedStates: Array<{ compactedBase: string; lastCompactedMessageRowId: number }> = []
    const messages = Array.from({ length: 41 }, (_, index) => makeMessage(index + 1))

    await compactConversationIfNeeded(1, 'qq_group:1', {
      ...TEST_DEPS_LEGACY_THRESHOLDS,
      getConversationState: async () => ({
        id: 1,
        groupId: 1,
        senderThreadKey: 'qq_group:1',
        compactedBase: '',
        compactedVersion: 1,
        lastCompactedMessageRowId: undefined,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      getMessagesAfterRowId: async () => messages,
      getActionRecordsForScene: async (sceneId) => {
        assert.equal(sceneId, 'qq_group:1')
        return [{
          id: 'action-1',
          actionIntentId: 'intent-1',
          actionType: 'send_group_reply',
          targetSceneId: 'qq_group:1',
          deliveryState: 'sent',
          idempotencyKey: 'intent-1',
          resultPayload: {
            sourceRefs: { incorporatedMessageRowId: 2, source: 'messages' },
            proposedEffect: { type: 'reply_to_message', text: '机器人回复' },
          },
          createdAt: new Date('2026-04-21T00:02:30Z'),
          updatedAt: new Date('2026-04-21T00:02:30Z'),
        }]
      },
      saveCompactedState: async (params) => {
        savedStates.push({
          compactedBase: params.compactedBase,
          lastCompactedMessageRowId: params.lastCompactedMessageRowId,
        })
      },
      summarizer: makeMockSummarizer({
        output: '摘要',
        capture: { calls: summarizerCalls },
      }),
    })

    // summarizer 看到的 history 包含 model role 条目 (干净 text, 不是 [BOT] xxx)
    const sent = summarizerCalls[0]?.historyToCompress ?? []
    const modelMessages = sent.filter((m) => 'role' in m && m.role === 'model')
    assert.equal(modelMessages.length, 1)
    assert.equal((modelMessages[0] as { role: 'model'; content: string }).content, '机器人回复')
  })

  test('previousSummary 被透传给 summarizer (合并不是简单 append)', async () => {
    const summarizerCalls: Array<{ previousSummary: string | null; historyToCompress: AgentMessage[] }> = []
    const messages = Array.from({ length: 41 }, (_, index) => makeMessage(index + 1))

    await compactConversationIfNeeded(1, 'qq_group:1', {
      ...TEST_DEPS_LEGACY_THRESHOLDS,
      getConversationState: async () => ({
        id: 1,
        groupId: 1,
        senderThreadKey: 'qq_group:1',
        compactedBase: '上次的摘要内容',
        compactedVersion: 1,
        lastCompactedMessageRowId: undefined,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      getMessagesAfterRowId: async () => messages,
      getActionRecordsForScene: async () => [],
      saveCompactedState: async () => {},
      summarizer: makeMockSummarizer({
        output: '新摘要',
        capture: { calls: summarizerCalls },
      }),
    })

    assert.equal(summarizerCalls[0]?.previousSummary, '上次的摘要内容')
  })

  test('不传 summarizer 时跳过 (不做 text concat)', async () => {
    const savedStates: Array<unknown> = []
    const messages = Array.from({ length: 41 }, (_, index) => makeMessage(index + 1))

    await compactConversationIfNeeded(1, 'qq_group:1', {
      ...TEST_DEPS_LEGACY_THRESHOLDS,
      getConversationState: async () => ({
        id: 1,
        groupId: 1,
        senderThreadKey: 'qq_group:1',
        compactedBase: '',
        compactedVersion: 1,
        lastCompactedMessageRowId: undefined,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      getMessagesAfterRowId: async () => messages,
      getActionRecordsForScene: async () => [],
      saveCompactedState: async (params) => {
        savedStates.push(params)
      },
      // 故意不传 summarizer
    })

    // 没注入 summarizer → 不写状态, 不做文本拼接
    assert.equal(savedStates.length, 0)
  })

  test('summarizer 返回空字符串时跳过写入', async () => {
    const savedStates: Array<unknown> = []
    const messages = Array.from({ length: 41 }, (_, index) => makeMessage(index + 1))

    await compactConversationIfNeeded(1, 'qq_group:1', {
      ...TEST_DEPS_LEGACY_THRESHOLDS,
      getConversationState: async () => ({
        id: 1,
        groupId: 1,
        senderThreadKey: 'qq_group:1',
        compactedBase: '',
        compactedVersion: 1,
        lastCompactedMessageRowId: undefined,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      getMessagesAfterRowId: async () => messages,
      getActionRecordsForScene: async () => [],
      saveCompactedState: async (params) => {
        savedStates.push(params)
      },
      summarizer: makeMockSummarizer({ output: '   ' }),
    })

    assert.equal(savedStates.length, 0)
  })

  test('生产默认阈值 (80/20): 41 条不触发, 81 条触发', async () => {
    const savedStates: Array<unknown> = []

    // 41 条: 默认阈值 80, 不触发
    await compactConversationIfNeeded(1, 'qq_group:1', {
      getConversationState: async () => ({
        id: 1,
        groupId: 1,
        senderThreadKey: 'qq_group:1',
        compactedBase: '',
        compactedVersion: 1,
        lastCompactedMessageRowId: undefined,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      getMessagesAfterRowId: async () => Array.from({ length: 41 }, (_, i) => makeMessage(i + 1)),
      getActionRecordsForScene: async () => [],
      saveCompactedState: async (params) => {
        savedStates.push(params)
      },
      summarizer: makeMockSummarizer({ output: '摘要' }),
    })
    assert.equal(savedStates.length, 0)

    // 81 条: 默认阈值 80, 触发
    await compactConversationIfNeeded(1, 'qq_group:1', {
      getConversationState: async () => ({
        id: 1,
        groupId: 1,
        senderThreadKey: 'qq_group:1',
        compactedBase: '',
        compactedVersion: 1,
        lastCompactedMessageRowId: undefined,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      getMessagesAfterRowId: async () => Array.from({ length: 81 }, (_, i) => makeMessage(i + 1)),
      getActionRecordsForScene: async () => [],
      saveCompactedState: async (params) => {
        savedStates.push(params)
      },
      summarizer: makeMockSummarizer({ output: '摘要' }),
    })
    assert.equal(savedStates.length, 1)
  })
})
