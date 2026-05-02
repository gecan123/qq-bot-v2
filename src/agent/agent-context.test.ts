import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CONTROL_TOOL_NAMES,
  createAgentContext,
  type AgentContextSnapshot,
} from './agent-context.js'
import type { ToolCall, ToolResult } from './types.js'

function makeToolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, args }
}

function makeToolResult(callId: string, name: string, output: string): ToolResult {
  return { callId, name, output }
}

describe('AgentContext (Phase A 契约测试)', () => {
  test('byte-stable: 同一序列重放后 snapshot 字节相等', async () => {
    const a = createAgentContext()
    const b = createAgentContext()

    for (const ctx of [a, b]) {
      await ctx.appendUserMessage({ role: 'user', content: '群友A: 在吗' })
      await ctx.appendAssistantTurn({ role: 'model', content: '在' })
      await ctx.appendUserMessage({ role: 'user', content: '群友A: 帮我查一下' })
      await ctx.appendToolCalls([makeToolCall('c1', 'db_read', { sql: 'select 1' })])
      await ctx.appendToolResults([makeToolResult('c1', 'db_read', '{"rows":[{"x":1}]}')])
      await ctx.appendAssistantTurn({ role: 'model', content: '查到了 1' })
    }

    const snapA = await a.getSnapshot()
    const snapB = await b.getSnapshot()
    assert.equal(JSON.stringify(snapA.messages), JSON.stringify(snapB.messages))
    assert.equal(snapA.messages.length, 6)
  })

  test('tool 跨轮可见: 上一轮的 tool_calls + tool_results 在下一轮 snapshot 里仍存在', async () => {
    const ctx = createAgentContext()
    await ctx.appendUserMessage({ role: 'user', content: '查询 X' })
    await ctx.appendToolCalls([makeToolCall('call-1', 'db_read', { sql: 'select x' })])
    await ctx.appendToolResults([makeToolResult('call-1', 'db_read', 'X=42')])
    await ctx.appendAssistantTurn({ role: 'model', content: 'X=42' })
    // 模拟下一轮的入站
    await ctx.appendUserMessage({ role: 'user', content: '那 Y 呢' })

    const snap = await ctx.getSnapshot()
    const toolCallTurn = snap.messages.find((m) => m.role === 'tool_calls')
    const toolResultTurn = snap.messages.find((m) => m.role === 'tool_results')
    assert.ok(toolCallTurn, 'tool_calls turn 应该跨轮存在')
    assert.ok(toolResultTurn, 'tool_results turn 应该跨轮存在')
    assert.equal((toolCallTurn as Extract<typeof toolCallTurn, { role: 'tool_calls' }>).calls[0]?.id, 'call-1')
    assert.equal((toolResultTurn as Extract<typeof toolResultTurn, { role: 'tool_results' }>).results[0]?.output, 'X=42')
  })

  test('compaction 保留 tail: replaceMessages 后 kept 部分字节不变', async () => {
    const ctx = createAgentContext()
    await ctx.appendUserMessage({ role: 'user', content: '老消息1' })
    await ctx.appendAssistantTurn({ role: 'model', content: '回答1' })
    await ctx.appendUserMessage({ role: 'user', content: '老消息2' })
    await ctx.appendAssistantTurn({ role: 'model', content: '回答2' })
    await ctx.appendUserMessage({ role: 'user', content: '新消息1' })
    await ctx.appendAssistantTurn({ role: 'model', content: '新回答1' })

    const before = await ctx.getSnapshot()
    const tail = before.messages.slice(-2) // 保留最后 2 条
    const tailJson = JSON.stringify(tail)

    await ctx.replaceMessages([
      { role: 'user', content: '[历史摘要]\n之前聊了老消息1/2' },
      ...tail,
    ])

    const after = await ctx.getSnapshot()
    assert.equal(after.messages.length, 3)
    assert.equal(after.messages[0]?.role, 'user')
    assert.match(
      (after.messages[0] as Extract<typeof after.messages[0], { role: 'user' }>).content,
      /历史摘要/,
    )
    // kept tail 必须 byte-identical
    assert.equal(JSON.stringify(after.messages.slice(1)), tailJson)
  })

  test('控制工具不入账: final_answer call 转成 model role,普通 tool 正常入账', async () => {
    const ctx = createAgentContext()
    await ctx.appendUserMessage({ role: 'user', content: '帮我' })

    // 普通 tool 先入账
    await ctx.appendToolCalls([makeToolCall('c1', 'db_read', { sql: 'select 1' })])
    await ctx.appendToolResults([makeToolResult('c1', 'db_read', '1')])

    // final_answer 通过同一入口提交时,不能作为 tool_calls 落账
    await ctx.appendToolCalls([makeToolCall('c2', 'final_answer', { text: '最终回复内容' })])

    const snap = await ctx.getSnapshot()
    const toolCallTurns = snap.messages.filter((m) => m.role === 'tool_calls')
    // 只有那一次 db_read,final_answer 不应该作为 tool_calls
    assert.equal(toolCallTurns.length, 1)
    const onlyToolCall = toolCallTurns[0] as Extract<typeof snap.messages[0], { role: 'tool_calls' }>
    assert.equal(onlyToolCall.calls[0]?.name, 'db_read')

    // final_answer 应该已经作为 model role 落账
    const lastModel = [...snap.messages].reverse().find((m) => m.role === 'model')
    assert.ok(lastModel, 'final_answer 应该转成 model role')
    assert.equal(
      (lastModel as Extract<typeof lastModel, { role: 'model' }>).content,
      '最终回复内容',
    )

    // 控制工具白名单显式声明
    assert.ok(CONTROL_TOOL_NAMES.has('final_answer'))
  })

  test('exportSnapshot / restoreFromSnapshot 是对称的', async () => {
    const a = createAgentContext()
    await a.appendUserMessage({ role: 'user', content: 'hi' })
    await a.appendAssistantTurn({ role: 'model', content: 'hello' })
    await a.appendToolCalls([makeToolCall('c1', 'db_read', {})])
    await a.appendToolResults([makeToolResult('c1', 'db_read', 'ok')])

    const exported = await a.exportSnapshot()

    const b = createAgentContext()
    await b.restoreFromSnapshot(exported)

    const snapB = await b.getSnapshot()
    assert.equal(JSON.stringify(snapB.messages), JSON.stringify((await a.getSnapshot()).messages))
  })

  test('reset 清空所有消息', async () => {
    const ctx = createAgentContext()
    await ctx.appendUserMessage({ role: 'user', content: 'x' })
    await ctx.reset()
    const snap = await ctx.getSnapshot()
    assert.equal(snap.messages.length, 0)
  })

  test('appendToolCalls 输入空数组时不写入', async () => {
    const ctx = createAgentContext()
    await ctx.appendToolCalls([])
    const snap = await ctx.getSnapshot()
    assert.equal(snap.messages.length, 0)
  })

  test('混合控制工具和普通工具的 batch 也要拆开处理', async () => {
    const ctx = createAgentContext()
    await ctx.appendToolCalls([
      makeToolCall('c1', 'db_read', { sql: 'select 1' }),
      makeToolCall('c2', 'final_answer', { text: '回复' }),
    ])
    const snap = await ctx.getSnapshot()
    // db_read 进 tool_calls,final_answer 转 model
    const toolCallTurns = snap.messages.filter((m) => m.role === 'tool_calls')
    assert.equal(toolCallTurns.length, 1)
    assert.equal(
      (toolCallTurns[0] as Extract<typeof snap.messages[0], { role: 'tool_calls' }>).calls.length,
      1,
    )
    const modelMessages = snap.messages.filter((m) => m.role === 'model')
    assert.equal(modelMessages.length, 1)
    assert.equal(
      (modelMessages[0] as Extract<typeof snap.messages[0], { role: 'model' }>).content,
      '回复',
    )
  })

  test('snapshot 是只读副本,外部修改不影响内部状态', async () => {
    const ctx = createAgentContext()
    await ctx.appendUserMessage({ role: 'user', content: 'hi' })
    const snap1 = await ctx.getSnapshot()
    // 试图突变
    ;(snap1.messages as { role: string; content: string }[]).push({ role: 'user', content: '篡改' })
    const snap2 = await ctx.getSnapshot()
    assert.equal(snap2.messages.length, 1)
  })
})

describe('AgentContextSnapshot 类型形态', () => {
  test('snapshot 仅暴露 messages 字段', async () => {
    const ctx = createAgentContext()
    const snap: AgentContextSnapshot = await ctx.getSnapshot()
    // 编译期保护:形态必须是 { messages: AgentMessage[] }
    assert.ok(Array.isArray(snap.messages))
  })
})
