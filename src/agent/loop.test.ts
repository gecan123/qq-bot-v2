import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runAgentLoop } from './loop.js'
import type { AgentLlmAdapter, AgentTurnResult, AgentLoopResult } from './types.js'
import { z } from 'zod'

function makeAdapter(responses: AgentTurnResult[]): AgentLlmAdapter {
  let callCount = 0
  return {
    async chat() {
      const response = responses[callCount]
      callCount++
      return response ?? { type: 'empty' }
    },
  }
}

const noopTools = {
  declarations: [],
  executors: {},
}

describe('runAgentLoop', () => {
  test('returns final when final_answer tool is called', async () => {
    const adapter = makeAdapter([
      {
        type: 'tool_calls',
        calls: [{ id: 'call_1', name: 'final_answer', args: { text: '这是答案' } }],
      },
    ])

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      adapter,
      tools: noopTools.declarations,
      executors: noopTools.executors,
    })

    assert.equal(result.state, 'final')
    if (result.state === 'final') {
      assert.equal(result.answer, '这是答案')
      assert.equal(result.termination, 'final_answer')
    }
  })

  test('truncates final_answer to 500 chars', async () => {
    const longText = 'x'.repeat(600)
    const adapter = makeAdapter([
      {
        type: 'tool_calls',
        calls: [{ id: 'call_1', name: 'final_answer', args: { text: longText } }],
      },
    ])

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      adapter,
      tools: noopTools.declarations,
      executors: noopTools.executors,
    })

    assert.equal(result.state, 'final')
    if (result.state === 'final') {
      assert.equal(result.answer.length, 500)
    }
  })

  test('returns final with implicit_text when adapter returns text', async () => {
    const adapter = makeAdapter([{ type: 'text', content: '直接回复' }])

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      adapter,
      tools: noopTools.declarations,
      executors: noopTools.executors,
    })

    assert.equal(result.state, 'final')
    if (result.state === 'final') {
      assert.equal(result.answer, '直接回复')
      assert.equal(result.termination, 'implicit_text')
    }
  })

  test('returns fallback when adapter returns empty', async () => {
    const adapter = makeAdapter([{ type: 'empty' }])

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      adapter,
      tools: noopTools.declarations,
      executors: noopTools.executors,
    })

    assert.equal(result.state, 'fallback')
    if (result.state === 'fallback') {
      assert.equal(result.reason, 'empty_response')
    }
  })

  test('returns aborted when maxSteps exceeded', async () => {
    // Adapter always returns tool calls that don't terminate
    const neverEndingAdapter: AgentLlmAdapter = {
      async chat() {
        return {
          type: 'tool_calls',
          calls: [{ id: 'call_x', name: 'unknown_tool', args: {} }],
        }
      },
    }

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      adapter: neverEndingAdapter,
      tools: noopTools.declarations,
      executors: {},
      maxSteps: 2,
    })

    assert.equal(result.state, 'aborted')
    if (result.state === 'aborted') {
      assert.equal(result.reason, 'max_steps_exceeded')
    }
  })

  test('uses default maxSteps=12 when maxSteps is not provided', async () => {
    let calls = 0
    const neverEndingAdapter: AgentLlmAdapter = {
      async chat() {
        calls++
        return {
          type: 'tool_calls',
          calls: [{ id: `call_${calls}`, name: 'unknown_tool', args: {} }],
        }
      },
    }

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      adapter: neverEndingAdapter,
      tools: noopTools.declarations,
      executors: {},
    })

    assert.equal(result.state, 'aborted')
    assert.equal(calls, 12)
    if (result.state === 'aborted') {
      assert.equal(result.reason, 'max_steps_exceeded')
    }
  })

  test('keeps running and returns final when exceeding warning threshold', async () => {
    const slowAdapter: AgentLlmAdapter = {
      async chat() {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return { type: 'text', content: '太慢了' }
      },
    }

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      adapter: slowAdapter,
      tools: noopTools.declarations,
      executors: noopTools.executors,
      warningTimeMs: 50,
    })

    assert.equal(result.state, 'final')
    if (result.state === 'final') {
      assert.equal(result.answer, '太慢了')
      assert.equal(result.termination, 'implicit_text')
    }
  })

  test('executes tool and passes result back', async () => {
    let toolExecuted = false
    const callHistory: string[] = []

    const adapter: AgentLlmAdapter = {
      async chat({ history }) {
        callHistory.push(`call_${history.length}`)
        if (history.length === 1) {
          // First call: request a tool
          return {
            type: 'tool_calls',
            calls: [{ id: 'call_1', name: 'test_tool', args: {} }],
          }
        }
        // Second call: after tool result, return final answer
        return {
          type: 'tool_calls',
          calls: [{ id: 'call_2', name: 'final_answer', args: { text: '工具执行完毕' } }],
        }
      },
    }

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      adapter,
      tools: noopTools.declarations,
      executors: {
        test_tool: async () => {
          toolExecuted = true
          return '工具结果'
        },
      },
    })

    assert.equal(toolExecuted, true)
    assert.equal(result.state, 'final')
  })

  test('returns fallback when adapter throws', async () => {
    const throwingAdapter: AgentLlmAdapter = {
      async chat() {
        throw new Error('LLM error')
      },
    }

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      adapter: throwingAdapter,
      tools: noopTools.declarations,
      executors: noopTools.executors,
    })

    assert.equal(result.state, 'fallback')
  })
})
