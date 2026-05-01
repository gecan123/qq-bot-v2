import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { z } from 'zod'
import { buildContextFrame } from './context-frame.js'
import { setLlmTraceCreateForTest, withLlmTrace } from './llm-trace.js'
import type { AgentMessage } from './types.js'

describe('llm trace context-frame metadata', () => {
  let restoreCreate: (() => void) | undefined

  afterEach(() => {
    restoreCreate?.()
    restoreCreate = undefined
  })

  test('records frame metadata, loop index, input hash, and cache usage', async () => {
    const createCalls: Array<{ data: Record<string, unknown> }> = []
    restoreCreate = setLlmTraceCreateForTest(async (input) => {
      createCalls.push(input as { data: Record<string, unknown> })
      return { id: 1 } as never
    })
    const history: AgentMessage[] = [{ role: 'user', content: 'hello' }]
    const frame = buildContextFrame({
      sceneId: 'qq_group:1',
      opportunityId: 'opp-1',
      systemPromptVersion: 'reply-system-prompt:v1',
      systemPrompt: 'system',
      initialHistory: history,
      sourceRefs: {
        sourceKind: 'mention',
        deliveryMode: 'reply_to_message',
        triggerMessageRowId: 1,
        incorporatedMessageRowId: 1,
        messageCursorStart: 1,
        messageCursorEnd: 1,
        includedActionRecordIds: [],
        compactionSegmentIds: [],
      },
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    })
    const traced = withLlmTrace(async () => ({
      type: 'text',
      content: 'ok',
      model: 'claude-sonnet-4-6',
      usage: {
        inputTokens: 10,
        cachedTokens: 4,
        outputTokens: 2,
        tokenUsageState: 'captured',
        rawUsage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } },
      },
    }), 1, frame)

    await traced({
      systemPrompt: 'system',
      history,
      tools: [{ name: 'final_answer', description: 'finish', inputSchema: z.object({ replyText: z.string() }) }],
      loopIndex: 2,
    })

    const data = createCalls[0]?.data as Record<string, unknown>
    assert.equal(data.frameId, frame.frameId)
    assert.equal(data.sceneId, 'qq_group:1')
    assert.equal(data.opportunityId, 'opp-1')
    assert.equal(data.loopIndex, 2)
    assert.equal(typeof data.inputHash, 'string')
    assert.equal(data.prefixHash, frame.prefixHash)
    assert.equal(data.tailHash, frame.tailHash)
    assert.equal(data.inputTokens, 10)
    assert.equal(data.cachedTokens, 4)
    assert.equal(data.outputTokens, 2)
    assert.equal(data.tokenUsageState, 'captured')
  })

  test('keeps no-frame trace inserts backward compatible', async () => {
    const createCalls: Array<{ data: Record<string, unknown> }> = []
    restoreCreate = setLlmTraceCreateForTest(async (input) => {
      createCalls.push(input as { data: Record<string, unknown> })
      return { id: 1 } as never
    })
    const traced = withLlmTrace(async () => ({
      type: 'text',
      content: 'ok',
      model: 'model',
      usage: { inputTokens: 3, cachedTokens: null, outputTokens: 1, tokenUsageState: 'unavailable' },
    }), 1)

    await traced({
      systemPrompt: 'system',
      history: [{ role: 'user', content: 'hello' }],
      tools: [],
      loopIndex: 1,
    })

    const data = createCalls[0]?.data as Record<string, unknown>
    assert.equal(data.frameId, undefined)
    assert.equal(data.contextFrame, undefined)
    assert.equal(data.tokenUsageState, 'unavailable')
  })
})
