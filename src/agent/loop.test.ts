import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runAgentLoop } from './loop.js'
import { createAgentContext } from './agent-context.js'
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

  test('returns fallback when implicit text is disallowed', async () => {
    const chatFn = makeChatFn([{ type: 'text', content: '这个我刚说过了，不重复。' }])

    const result = await runAgentLoop({
      systemPrompt: 'test',
      userMessage: '问题',
      chatFn,
      tools: noopTools.declarations,
      executors: noopTools.executors,
      allowImplicitText: false,
    })

    assert.equal(result.state, 'fallback')
    if (result.state === 'fallback') {
      assert.equal(result.reason, 'implicit_text_disallowed')
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

  test('uses initial AgentContext history as starting history when provided', async () => {
    const receivedHistories: unknown[][] = []
    const chatFn = async ({ history }: { history: unknown[] }) => {
      receivedHistories.push([...history])
      return {
        type: 'tool_calls' as const,
        calls: [{ id: 'call_1', name: 'final_answer', args: { replyText: '回复' } }],
      }
    }

    const context = createAgentContext({
      initialMessages: [
        { role: 'user', content: '[近期会话背景]\n消息记录' },
        { role: 'user', content: '[当前要回复的消息]\n你好' },
      ],
    })

    await runAgentLoop({
      systemPrompt: 'test',
      context,
      chatFn,
      tools: noopTools.declarations,
      executors: noopTools.executors,
    })

    assert.equal(receivedHistories.length, 1)
    const firstHistory = receivedHistories[0] as Array<{ role: string; content: string }>
    assert.equal(firstHistory.length, 2)
    assert.equal(firstHistory[0]?.role, 'user')
    assert.match(firstHistory[0]?.content ?? '', /近期会话背景/)
    assert.equal(firstHistory[1]?.role, 'user')
    assert.match(firstHistory[1]?.content ?? '', /当前要回复的消息/)
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

  describe('ephemeralSuffix', () => {
    test('without ephemeralSuffix: history equals snapshot.messages (backwards compat)', async () => {
      const histories: { length: number; lastContent: string }[] = []
      const chatFn = async ({ history }: { history: import('./types.js').AgentMessage[] }) => {
        const last = history[history.length - 1]
        const lastContent = last && 'content' in last && typeof last.content === 'string' ? last.content : ''
        histories.push({ length: history.length, lastContent })
        return { type: 'tool_calls' as const, calls: [{ id: 'c1', name: 'final_answer', args: { replyText: 'done' } }] }
      }

      const ctx = createAgentContext()
      await ctx.appendUserMessage({ role: 'user', content: 'hi' })

      await runAgentLoop({
        systemPrompt: 'test',
        context: ctx,
        chatFn,
        tools: noopTools.declarations,
        executors: noopTools.executors,
      })

      assert.equal(histories.length, 1)
      assert.equal(histories[0]?.length, 1)
      assert.equal(histories[0]?.lastContent, 'hi')
    })

    test('static array suffix: appended to history each step, never persisted to context', async () => {
      const histories: { content: string }[][] = []
      const chatFn = async ({ history }: { history: import('./types.js').AgentMessage[] }) => {
        histories.push(history.map((m) => ({
          content: 'content' in m && typeof m.content === 'string' ? m.content : '',
        })))
        // 第一步 db_read,第二步 final_answer (走完两步,验证 suffix 在每步都注入)
        if (histories.length === 1) {
          return { type: 'tool_calls' as const, calls: [{ id: 'c1', name: 'noop', args: {} }] }
        }
        return { type: 'tool_calls' as const, calls: [{ id: 'c2', name: 'final_answer', args: { replyText: 'ok' } }] }
      }

      const ctx = createAgentContext()
      await ctx.appendUserMessage({ role: 'user', content: 'q' })

      await runAgentLoop({
        systemPrompt: 'test',
        context: ctx,
        chatFn,
        tools: noopTools.declarations,
        executors: { noop: async () => 'noop_result' },
        ephemeralSuffix: [{ role: 'user', content: '[transient note]' }],
      })

      // 两次 chatFn 都该看到 suffix 在末尾
      assert.equal(histories.length, 2)
      assert.equal(histories[0]?.[histories[0].length - 1]?.content, '[transient note]')
      assert.equal(histories[1]?.[histories[1].length - 1]?.content, '[transient note]')

      // 但 context.snapshot 永远不该有 suffix——它只记录真实 message 流转
      const snapshot = await ctx.getSnapshot()
      const hasSuffixInSnapshot = snapshot.messages.some(
        (m) => m.role === 'user' && m.content === '[transient note]',
      )
      assert.equal(hasSuffixInSnapshot, false, 'suffix 不应该被持久化到 AgentContext')
    })

    test('function suffix: receives loopIndex, can return different content per step', async () => {
      const histories: { length: number; suffixSeen: string | undefined }[] = []
      const chatFn = async ({ history }: { history: import('./types.js').AgentMessage[] }) => {
        const last = history[history.length - 1]
        const lastContent = last && 'content' in last && typeof last.content === 'string' ? last.content : ''
        histories.push({
          length: history.length,
          suffixSeen: lastContent.startsWith('[step-') ? lastContent : undefined,
        })
        if (histories.length === 1) {
          return { type: 'tool_calls' as const, calls: [{ id: 'c1', name: 'noop', args: {} }] }
        }
        return { type: 'tool_calls' as const, calls: [{ id: 'c2', name: 'final_answer', args: { replyText: 'ok' } }] }
      }

      const ctx = createAgentContext()
      await ctx.appendUserMessage({ role: 'user', content: 'q' })

      await runAgentLoop({
        systemPrompt: 'test',
        context: ctx,
        chatFn,
        tools: noopTools.declarations,
        executors: { noop: async () => 'noop_result' },
        ephemeralSuffix: (loopIndex) => [{ role: 'user', content: `[step-${loopIndex}]` }],
      })

      assert.equal(histories[0]?.suffixSeen, '[step-1]', 'loopIndex 应从 1 开始')
      assert.equal(histories[1]?.suffixSeen, '[step-2]', '第二步应看到不同的 suffix')
    })

    test('async function suffix is awaited', async () => {
      const histories: { lastContent: string | undefined }[] = []
      const chatFn = async ({ history }: { history: import('./types.js').AgentMessage[] }) => {
        const last = history[history.length - 1]
        const lastContent = last && 'content' in last && typeof last.content === 'string' ? last.content : undefined
        histories.push({ lastContent })
        return { type: 'tool_calls' as const, calls: [{ id: 'c1', name: 'final_answer', args: { replyText: 'ok' } }] }
      }

      const ctx = createAgentContext()
      await ctx.appendUserMessage({ role: 'user', content: 'q' })

      await runAgentLoop({
        systemPrompt: 'test',
        context: ctx,
        chatFn,
        tools: noopTools.declarations,
        executors: noopTools.executors,
        ephemeralSuffix: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return [{ role: 'user', content: '[awaited]' }]
        },
      })

      assert.equal(histories[0]?.lastContent, '[awaited]')
    })

    test('function suffix returning empty array is treated as no suffix', async () => {
      const histories: { length: number }[] = []
      const chatFn = async ({ history }: { history: unknown[] }) => {
        histories.push({ length: history.length })
        return { type: 'tool_calls' as const, calls: [{ id: 'c1', name: 'final_answer', args: { replyText: 'ok' } }] }
      }

      const ctx = createAgentContext()
      await ctx.appendUserMessage({ role: 'user', content: 'q' })

      await runAgentLoop({
        systemPrompt: 'test',
        context: ctx,
        chatFn,
        tools: noopTools.declarations,
        executors: noopTools.executors,
        ephemeralSuffix: () => [],
      })

      assert.equal(histories[0]?.length, 1, 'empty 数组不应该往 history 加东西')
    })
  })
})
