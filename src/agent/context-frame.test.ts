import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import {
  buildContextFrame,
  buildInputHash,
  normalizeContextFrameTokenUsage,
  stableHash,
} from './context-frame.js'

describe('context frame hashing', () => {
  test('hashes object keys deterministically and preserves array order', () => {
    assert.equal(stableHash({ b: 2, a: 1 }), stableHash({ a: 1, b: 2 }))
    assert.notEqual(stableHash({ a: [1, 2] }), stableHash({ a: [2, 1] }))
  })

  test('treats absent and undefined optional fields consistently', () => {
    assert.equal(stableHash({ a: 1, b: undefined }), stableHash({ a: 1 }))
  })

  test('derives a stable frame id from source identity and rendered prompt material', () => {
    const base = {
      sceneId: 'qq_group:100',
      opportunityId: 'opp-1',
      systemPromptVersion: 'reply-system-prompt:v1',
      systemPrompt: 'system',
      initialHistory: [
        { role: 'user' as const, content: '[近期会话背景]\nhello' },
        { role: 'user' as const, content: '[当前要回复的消息]\n@bot hi' },
      ],
      sourceRefs: {
        sourceKind: 'mention',
        deliveryMode: 'reply_to_message',
        triggerMessageRowId: 10,
        incorporatedMessageRowId: 10,
        messageCursorStart: 1,
        messageCursorEnd: 9,
        includedActionRecordIds: ['a1'],
        maxActionAnchor: 8,
        compactionSegmentIds: [],
      },
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    }

    const left = buildContextFrame(base)
    const right = buildContextFrame(base)

    assert.equal(left.frameId, right.frameId)
    assert.equal(left.prefixHash, right.prefixHash)
    assert.equal(left.tailHash, right.tailHash)
  })

  test('Phase 1.5: prefixHash 跨多轮稳定 - 只要 system + summary head 不变, window/trigger 变了仍然命中 cache', () => {
    const base = {
      sceneId: 'qq_group:100',
      opportunityId: 'opp-1',
      systemPromptVersion: 'reply-system-prompt:v1',
      systemPrompt: 'system',
      sourceRefs: {
        sourceKind: 'mention',
        deliveryMode: 'reply_to_message',
        triggerMessageRowId: 10,
        incorporatedMessageRowId: 10,
        messageCursorStart: 1,
        messageCursorEnd: 9,
        includedActionRecordIds: [],
        maxActionAnchor: undefined,
        compactionSegmentIds: [],
      },
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    }

    // 第一轮: 有 summary head + 短 window
    const round1 = buildContextFrame({
      ...base,
      initialHistory: [
        { role: 'user' as const, content: '[历史摘要]\n昨天聊了电影。' },
        { role: 'user' as const, content: '用户A: 早' },
        { role: 'user' as const, content: '[当前要回复的消息]\n@bot hi' },
      ],
    })

    // 第二轮: summary head 完全相同, 但 window 多了一条新群消息, trigger 也变了
    const round2 = buildContextFrame({
      ...base,
      sourceRefs: { ...base.sourceRefs, triggerMessageRowId: 11, messageCursorEnd: 10 },
      initialHistory: [
        { role: 'user' as const, content: '[历史摘要]\n昨天聊了电影。' },
        { role: 'user' as const, content: '用户A: 早' },
        { role: 'model' as const, content: '早。今天聊点啥' },
        { role: 'user' as const, content: '[当前要回复的消息]\n@bot 你最近看啥了' },
      ],
    })

    // P0 核心保证: prefixHash 稳定不变
    assert.equal(round1.prefixHash, round2.prefixHash)
    // tailHash 变 (window 和 trigger 都变了)
    assert.notEqual(round1.tailHash, round2.tailHash)
  })

  test('Phase 1.5: 没有 summary head 时, prefixHash 只反映 systemPrompt 本身, 跨调用稳定', () => {
    const base = {
      sceneId: 'qq_group:100',
      opportunityId: 'opp-1',
      systemPromptVersion: 'reply-system-prompt:v1',
      systemPrompt: 'system',
      sourceRefs: {
        sourceKind: 'mention',
        triggerMessageRowId: 10,
        incorporatedMessageRowId: 10,
        includedActionRecordIds: [],
        compactionSegmentIds: [],
      },
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    }

    const noSummary1 = buildContextFrame({
      ...base,
      initialHistory: [
        { role: 'user' as const, content: '用户A: hi' },
        { role: 'user' as const, content: '[当前要回复的消息]\n@bot' },
      ],
    })
    const noSummary2 = buildContextFrame({
      ...base,
      initialHistory: [
        { role: 'user' as const, content: '用户A: hi' },
        { role: 'model' as const, content: '上次回复' },
        { role: 'user' as const, content: '[当前要回复的消息]\n@bot 又来了' },
      ],
    })

    assert.equal(noSummary1.prefixHash, noSummary2.prefixHash)
  })

  test('computes per-call input hashes from actual prompt, history, and tools', () => {
    const base = {
      systemPrompt: 'system',
      history: [{ role: 'user' as const, content: 'hello' }],
      tools: [{ name: 'final_answer', description: 'finish', inputSchema: z.object({ replyText: z.string() }) }],
    }

    assert.equal(buildInputHash(base), buildInputHash({ ...base, history: [{ role: 'user', content: 'hello' }] }))
    assert.notEqual(buildInputHash(base), buildInputHash({ ...base, history: [{ role: 'user', content: 'changed' }] }))
  })
})

describe('context frame token usage', () => {
  test('captures explicit cached tokens including true zero', () => {
    const usage = normalizeContextFrameTokenUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0 },
    })

    assert.equal(usage.tokenUsageState, 'captured')
    assert.equal(usage.inputTokens, 10)
    assert.equal(usage.cachedTokens, 0)
    assert.equal(usage.outputTokens, 2)
  })

  test('marks normal token totals without cache field as unavailable', () => {
    const usage = normalizeContextFrameTokenUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
    })

    assert.equal(usage.tokenUsageState, 'unavailable')
    assert.equal(usage.cachedTokens, null)
  })
})
