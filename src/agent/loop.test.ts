import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runAgentLoop } from './loop.js'
import type { AgentTurnResult } from './types.js'
import { createTraceRecorder } from './trace.js'

function makeChatFn(responses: AgentTurnResult[]) {
  let callCount = 0
  return async () => {
    const response = responses[callCount]
    callCount++
    return response ?? { type: 'empty' as const }
  }
}

const noopTools = {
  declarations: [],
  executors: {},
}

describe('runAgentLoop', () => {
  test('returns final when final_answer tool is called', async () => {
    const chatFn = makeChatFn([
      {
        type: 'tool_calls',
        calls: [{
          id: 'call_1',
          name: 'final_answer',
          args: {
            replyText: '这是答案',
            confidence: 'high',
            shouldReferenceContext: true,
            shouldAskClarifyingQuestion: false,
          },
        }],
      },
    ])

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
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
    const chatFn = makeChatFn([
      {
        type: 'tool_calls',
        calls: [{
          id: 'call_1',
          name: 'final_answer',
          args: {
            replyText: longText,
            confidence: 'medium',
            shouldReferenceContext: false,
            shouldAskClarifyingQuestion: false,
          },
        }],
      },
    ])

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
      tools: noopTools.declarations,
      executors: noopTools.executors,
    })

    assert.equal(result.state, 'final')
    if (result.state === 'final') {
      assert.equal(result.answer.length, 500)
    }
  })

  test('returns final with implicit_text when adapter returns text', async () => {
    const chatFn = makeChatFn([{ type: 'text', content: '直接回复' }])

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
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
    const chatFn = makeChatFn([{ type: 'empty' }])

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
      tools: noopTools.declarations,
      executors: noopTools.executors,
    })

    assert.equal(result.state, 'fallback')
    if (result.state === 'fallback') {
      assert.equal(result.reason, 'empty_response')
    }
  })

  test('returns aborted when maxSteps exceeded', async () => {
    const chatFn = async () => ({
      type: 'tool_calls' as const,
      calls: [{ id: 'call_x', name: 'unknown_tool', args: {} }],
    })

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
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
    const chatFn = async () => {
      calls++
      return {
        type: 'tool_calls' as const,
        calls: [{ id: `call_${calls}`, name: 'unknown_tool', args: {} }],
      }
    }

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
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
    const chatFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return { type: 'text' as const, content: '太慢了' }
    }

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
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

    const chatFn = async ({ history }: { history: unknown[] }) => {
      callHistory.push(`call_${history.length}`)
      if (history.length === 1) {
        return {
          type: 'tool_calls' as const,
          calls: [{ id: 'call_1', name: 'test_tool', args: {} }],
        }
      }
      return {
        type: 'tool_calls' as const,
        calls: [{
          id: 'call_2',
          name: 'final_answer',
          args: {
            replyText: '工具执行完毕',
            confidence: 'high',
            shouldReferenceContext: true,
            shouldAskClarifyingQuestion: false,
          },
        }],
      }
    }

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
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

  test('uses replyText instead of legacy text field for final_answer', async () => {
    const chatFn = makeChatFn([
      {
        type: 'tool_calls',
        calls: [{
          id: 'call_1',
          name: 'final_answer',
          args: {
            text: '旧字段',
            replyText: '新字段',
            confidence: 'low',
            shouldReferenceContext: false,
            shouldAskClarifyingQuestion: true,
          },
        }],
      },
    ])

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
      tools: noopTools.declarations,
      executors: noopTools.executors,
    })

    assert.equal(result.state, 'final')
    if (result.state === 'final') {
      assert.equal(result.answer, '新字段')
    }
  })

  test('uses initialHistory as starting history when provided', async () => {
    const receivedHistories: unknown[][] = []
    const chatFn = async ({ history }: { history: unknown[] }) => {
      receivedHistories.push([...history])
      return {
        type: 'tool_calls' as const,
        calls: [{ id: 'call_1', name: 'final_answer', args: { replyText: '回复' } }],
      }
    }

    await runAgentLoop({
      systemPrompt: 'test',
      initialHistory: [
        { role: 'user', content: '[群聊背景]\n消息记录' },
        { role: 'model', content: '好的。' },
        { role: 'user', content: '请回复这条消息：你好' },
      ],
      chatFn,
      tools: noopTools.declarations,
      executors: noopTools.executors,
    })

    assert.equal(receivedHistories.length, 1)
    const firstHistory = receivedHistories[0] as Array<{ role: string; content: string }>
    assert.equal(firstHistory.length, 3)
    assert.equal(firstHistory[0]?.role, 'user')
    assert.match(firstHistory[0]?.content ?? '', /群聊背景/)
    assert.equal(firstHistory[1]?.role, 'model')
    assert.equal(firstHistory[2]?.role, 'user')
    assert.match(firstHistory[2]?.content ?? '', /请回复/)
  })

  test('returns fallback when adapter throws', async () => {
    const chatFn = async () => {
      throw new Error('LLM error')
    }

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
      tools: noopTools.declarations,
      executors: noopTools.executors,
    })

    assert.equal(result.state, 'fallback')
  })

  test('emits trace events when recorder is provided', async () => {
    const chatFn = makeChatFn([
      {
        type: 'tool_calls',
        content: '先查一下数据库',
        calls: [{ id: 'call_1', name: 'test_tool', args: { keyword: 'foo' } }],
      },
      {
        type: 'tool_calls',
        calls: [{ id: 'call_2', name: 'final_answer', args: { replyText: '完成' } }],
      },
    ])
    const traceRecorder = createTraceRecorder({
      runId: 'run_trace',
      groupId: 1,
      senderName: 'tester',
      userMessage: 'hi',
    })

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
      tools: noopTools.declarations,
      executors: {
        test_tool: async () => '工具结果',
      },
      traceRecorder,
    })

    assert.equal(result.state, 'final')
    assert.ok(result.trace)
    assert.equal(result.trace?.terminationReason, 'final_answer')
    assert.ok(result.trace?.events.some((event) => event.phase === 'loop' && event.type === 'loop_started'))
    assert.ok(result.trace?.events.some((event) => event.type === 'think' && event.summary.includes('先查一下数据库')))
    assert.ok(result.trace?.events.some((event) => event.type === 'tool_call'))
    assert.ok(result.trace?.events.some((event) => event.phase === 'finalize'))
  })
})
