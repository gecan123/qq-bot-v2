import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { runPlayground } from './playground.js'
import type { AgentTurnResult } from '../agent/types.js'

describe('runPlayground', () => {
  test('returns trace with final termination and loop metadata', async () => {
    let chatCount = 0
    const result = await runPlayground(
      {
        groupId: '42',
        message: '你好',
        senderName: '测试用户',
      },
      {
        buildContext: async () => ({ contextText: '上下文', history: [], recentMessages: [] }),
        getAgentProfile: () => ({
          persona: '你是测试助手',
          replyContextMessages: 20,
          agentMaxSteps: 4,
          agentWarningTimeMs: 500,
          agentMaxTimeMs: 500,
          agentMaxAnswerChars: 500,
        }),
        createAgentTools: () => ({
          declarations: [],
          executors: {
            db_read: async () => '三条记录',
          },
        }),
        chatFn: async (): Promise<AgentTurnResult> => {
          chatCount++
          if (chatCount === 1) {
            return {
              type: 'tool_calls',
              content: '先检查会话记录',
              calls: [{ id: 'call_1', name: 'db_read', args: { limit: 3 } }],
            }
          }

          return {
            type: 'tool_calls',
            calls: [{ id: 'call_2', name: 'final_answer', args: { replyText: '最终答案' } }],
          }
        },
      },
    )

    assert.equal(result.state, 'final')
    assert.ok(result.trace)
    assert.equal(result.trace.finalState, 'final')
    assert.equal(result.trace.terminationReason, 'final_answer')
    assert.ok(result.trace.events.some((event) => event.type === 'loop_started'))
    assert.match(result.llmContext.systemPrompt, /你是测试助手/)
    // Phase 1.5: history 是真多轮, trigger 永远是最后一条 user message
    const lastMessage = result.llmContext.messages[result.llmContext.messages.length - 1]
    assert.equal(lastMessage?.role, 'user')
    assert.match(lastMessage?.content ?? '', /当前要回复的消息/)
    assert.deepEqual(result.finalAnswerPayload, { replyText: '最终答案' })
  })

  test('emits receive, load_context, plan, loop, and finalize phases', async () => {
    const result = await runPlayground(
      {
        groupId: '42',
        message: '你好',
        senderName: '测试用户',
      },
      {
        buildContext: async () => ({ contextText: '上下文', history: [], recentMessages: [] }),
        getAgentProfile: () => ({
          persona: '你是测试助手',
          replyContextMessages: 20,
          agentMaxSteps: 2,
          agentWarningTimeMs: 500,
          agentMaxTimeMs: 500,
          agentMaxAnswerChars: 500,
        }),
        createAgentTools: () => ({
          declarations: [],
          executors: {},
        }),
        chatFn: async (): Promise<AgentTurnResult> => ({
          type: 'tool_calls',
          calls: [{ id: 'call_1', name: 'final_answer', args: { replyText: '最终答案' } }],
        }),
      },
    )

    assert.ok(result.trace)
    const phases = Array.from(new Set(result.trace.events.map((event) => event.phase)))
    assert.deepEqual(phases, ['receive', 'load_context', 'plan', 'loop', 'finalize'])
    assert.deepEqual(result.llmContext.tools, [])
  })
})
