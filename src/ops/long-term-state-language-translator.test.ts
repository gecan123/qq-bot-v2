import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LlmCallOutput, LlmClient } from '../agent/llm-client.js'
import type { LongTermTranslationItem } from './long-term-state-language-migration.js'
import { createLongTermStateTranslator } from './long-term-state-language-translator.js'

const items: LongTermTranslationItem[] = [
  { key: 'memory:self/title', text: 'Migration notes', kind: 'title' },
]

function output(args?: unknown): LlmCallOutput {
  return {
    content: '',
    toolCalls: args === undefined ? [] : [{
      id: 'translation-1',
      name: 'long_term_state_translation_result',
      args: args as Record<string, unknown>,
    }],
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
    model: 'fake',
    contextWindowTokens: 10_000,
    stopReason: args === undefined ? 'end_turn' : 'tool_use',
  }
}

describe('createLongTermStateTranslator', () => {
  test('returns complete Chinese tool output and reports batch progress', async () => {
    const requests: Parameters<LlmClient['chat']>[0][] = []
    const llm: LlmClient = {
      async chat(request) {
        requests.push(request)
        return output({ items: [{ key: items[0]!.key, text: '迁移记录' }] })
      },
    }
    const progress: Array<{ completedBatches: number; totalBatches: number }> = []

    const translated = await createLongTermStateTranslator(llm)(items, value => progress.push(value))

    assert.deepEqual(translated, [{ key: items[0]!.key, text: '迁移记录' }])
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.tools[0]!.name, 'long_term_state_translation_result')
    assert.deepEqual(progress, [{ completedBatches: 1, totalBatches: 1 }])
  })

  test('retries one invalid response with a stricter prompt', async () => {
    let calls = 0
    const prompts: string[] = []
    const llm: LlmClient = {
      async chat(request) {
        calls += 1
        prompts.push(request.systemPrompt)
        return calls === 1
          ? output()
          : output({ items: [{ key: items[0]!.key, text: '迁移记录' }] })
      },
    }

    const translated = await createLongTermStateTranslator(llm)(items)

    assert.equal(calls, 2)
    assert.match(prompts[1]!, /上一次输出无效/)
    assert.deepEqual(translated, [{ key: items[0]!.key, text: '迁移记录' }])
  })

  test('rejects two invalid structured responses', async () => {
    let calls = 0
    const llm: LlmClient = {
      async chat() {
        calls += 1
        return output({ items: [{ key: 'unknown', text: '错误结果' }] })
      },
    }

    await assert.rejects(
      createLongTermStateTranslator(llm)(items),
      /returned invalid structured output twice/,
    )
    assert.equal(calls, 2)
  })
})
