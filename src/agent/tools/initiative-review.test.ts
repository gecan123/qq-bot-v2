import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { loadPrompt } from '../../config/prompt-loader.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { LlmCallInput, LlmClient } from '../llm-client.js'
import type { ToolContext } from '../tool.js'
import { createInitiativeReviewTool } from './initiative-review.js'

function makeCtx(roundIndex = 1): ToolContext {
  return {
    eventQueue: new InMemoryEventQueue<BotEvent>(),
    roundIndex,
  }
}

function createMockLlm(content: string, requests: LlmCallInput[] = []): LlmClient {
  return {
    async chat(input) {
      requests.push(input)
      return {
        content,
        toolCalls: [],
        usage: { inputTokens: 1_200, cachedTokens: 1_100, outputTokens: 20 },
        model: 'mock',
        contextWindowTokens: 200_000,
        stopReason: 'end_turn',
      }
    },
  }
}

describe('initiative_review tool', () => {
  test('uses the shared prompt as a tool-free system prefix and returns a positive rewrite', async () => {
    const requests: LlmCallInput[] = []
    const tool = createInitiativeReviewTool({
      llm: createMockLlm(
        '{"hasNegative":true,"rewritten":"趁现在把这件事推进完。"}',
        requests,
      ),
    })

    const result = await tool.execute({ text: '明天再弄吧。' }, makeCtx(7))
    const payload = JSON.parse(result.content as string)

    assert.deepEqual(payload, {
      ok: true,
      hasNegative: true,
      rewritten: '趁现在把这件事推进完。',
    })
    assert.deepEqual(result.outcome, { ok: true })
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.systemPrompt, loadPrompt('./prompts/tools/initiative-review.md'))
    assert.deepEqual(requests[0]?.messages, [{ role: 'user', content: '明天再弄吧。' }])
    assert.deepEqual(requests[0]?.tools, [])
    assert.equal(requests[0]?.maxOutputTokens, 8_192)
  })

  test('preserves the original bytes when the model reports no negative content', async () => {
    const original = '我正在整理资料，接下来直接写总结。'
    const tool = createInitiativeReviewTool({
      llm: createMockLlm(
        '{"hasNegative":false,"rewritten":"模型不应修改这段文字"}',
      ),
    })

    const result = await tool.execute({ text: original }, makeCtx())

    assert.deepEqual(JSON.parse(result.content as string), {
      ok: true,
      hasNegative: false,
      rewritten: original,
    })
  })

  test('returns a structured failure when the reviewer violates the JSON contract', async () => {
    const tool = createInitiativeReviewTool({
      llm: createMockLlm('不是 JSON'),
    })

    const result = await tool.execute({ text: '算了。' }, makeCtx())
    const payload = JSON.parse(result.content as string)

    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'initiative_review_failed')
    assert.deepEqual(result.outcome, {
      ok: false,
      code: 'initiative_review_failed',
      error: result.outcome?.error,
      progress: false,
    })
  })
})
