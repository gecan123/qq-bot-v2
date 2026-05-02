import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentContext } from '../agent/agent-context.js'
import type { AgentMessage } from '../agent/types.js'
import { maybeCompactConversation, type SummarizeFn, type SummarizeInput } from './compaction.js'

function captureSummarize(opts: {
  output: string
  capture?: { calls: SummarizeInput[] }
}): SummarizeFn {
  return async (input) => {
    opts.capture?.calls.push(input)
    return opts.output
  }
}

function makeUserMessage(text: string): AgentMessage {
  return { role: 'user', content: text }
}

function makeModelMessage(text: string): AgentMessage {
  return { role: 'model', content: text }
}

describe('compaction (Phase D, AgentContext-based)', () => {
  test('低于阈值时不动 context', async () => {
    const ctx = createAgentContext({
      initialMessages: Array.from({ length: 5 }, (_, i) => makeUserMessage(`短消息${i}`)),
    })
    const before = JSON.stringify((await ctx.getSnapshot()).messages)

    await maybeCompactConversation(ctx, {
      summarize: captureSummarize({ output: '不应该被调用' }),
      triggerTokens: 100_000,
    })

    const after = JSON.stringify((await ctx.getSnapshot()).messages)
    assert.equal(after, before)
  })

  test('超过阈值时 replaceMessages 写入 [历史摘要] 头 + 保留尾部', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => makeUserMessage(`长消息${i}`.repeat(50)))
    const ctx = createAgentContext({ initialMessages: messages })
    const summarizeCalls: SummarizeInput[] = []

    await maybeCompactConversation(ctx, {
      summarize: captureSummarize({
        output: '群里聊了 20 条长消息',
        capture: { calls: summarizeCalls },
      }),
      triggerTokens: 100,
      keepRatio: 0.1,
    })

    const after = (await ctx.getSnapshot()).messages
    // 头部是新 summary, 后面是 keep 部分 (ceil(20*0.1) = 2)
    assert.equal(after.length, 1 + 2)
    const head = after[0] as { role: string; content: string }
    assert.equal(head.role, 'user')
    assert.match(head.content, /^\[历史摘要\]\n群里聊了 20 条长消息/)

    // kept tail 必须 byte-identical 原 messages 的最后 2 条
    assert.deepEqual(after.slice(1), messages.slice(-2))

    // summarize 收到的 history 不含已被 replace 的部分,且 previousSummary 为 null
    assert.equal(summarizeCalls.length, 1)
    assert.equal(summarizeCalls[0]?.previousSummary, null)
    assert.equal(summarizeCalls[0]?.history.length, 18)
  })

  test('已有 [历史摘要] 头时, 抽出来作为 previousSummary 合并输入', async () => {
    const initial: AgentMessage[] = [
      makeUserMessage('[历史摘要]\n上次摘要的内容'),
      ...Array.from({ length: 30 }, (_, i) => makeUserMessage(`新消息${i}`.repeat(30))),
    ]
    const ctx = createAgentContext({ initialMessages: initial })
    const summarizeCalls: SummarizeInput[] = []

    await maybeCompactConversation(ctx, {
      summarize: captureSummarize({
        output: '合并后的新摘要',
        capture: { calls: summarizeCalls },
      }),
      triggerTokens: 100,
      keepRatio: 0.1,
    })

    assert.equal(summarizeCalls.length, 1)
    assert.equal(summarizeCalls[0]?.previousSummary, '上次摘要的内容')
    // history 不含旧 summary head, 只是新消息的前 N 条
    const sentHistory = summarizeCalls[0]?.history ?? []
    assert.ok(sentHistory.every((m) => !('content' in m && typeof m.content === 'string' && m.content.startsWith('[历史摘要]'))))
  })

  test('summarize 返回空白时不修改 context', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => makeUserMessage(`消息${i}`.repeat(50)))
    const ctx = createAgentContext({ initialMessages: messages })
    const before = JSON.stringify((await ctx.getSnapshot()).messages)

    await maybeCompactConversation(ctx, {
      summarize: captureSummarize({ output: '   ' }),
      triggerTokens: 100,
    })

    const after = JSON.stringify((await ctx.getSnapshot()).messages)
    assert.equal(after, before)
  })

  test('cut 边界不切开 tool_calls 和 tool_results', async () => {
    // 构造形态:5 user + (tool_calls + tool_results 紧邻) + 4 user
    // 阈值低 + keepRatio 让 cutIndex 落在 tool_calls 之后, 应该被推到 tool_results 之后
    const messages: AgentMessage[] = [
      ...Array.from({ length: 5 }, (_, i) => makeUserMessage(`u${i}`.repeat(50))),
      { role: 'tool_calls', calls: [{ id: 'c1', name: 'db_read', args: { sql: 'select 1' } }] },
      { role: 'tool_results', results: [{ callId: 'c1', name: 'db_read', output: 'X=42' }] },
      ...Array.from({ length: 4 }, (_, i) => makeUserMessage(`v${i}`.repeat(50))),
    ]
    // 总数 11; ceil(11*0.5) = 6, keep 6; cutIndex = 5 → 落在 user5 之后, 在 tool_calls 之前。OK 这种情况不需要修正。
    // 我换一个: keepRatio = 0.4 → keep 5; cutIndex = 6 → 落在 tool_calls 之后,要被推到 tool_results 之后 → cutIndex = 7
    const ctx = createAgentContext({ initialMessages: messages })

    await maybeCompactConversation(ctx, {
      summarize: captureSummarize({ output: '摘要' }),
      triggerTokens: 100,
      keepRatio: 0.4,
    })

    const after = (await ctx.getSnapshot()).messages
    // 新结构:[summary, ...tail]; tail 至少包含 4 个尾部 user, 不应该 leading 是 tool_results (孤立 result)
    assert.equal(after[0]?.role, 'user') // summary head
    // 第二条不能是孤立的 tool_results (没有对应的 tool_calls)
    assert.notEqual(after[1]?.role, 'tool_results')
  })

  test('调用方需 try/catch: summarize 抛错时 context 不变', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => makeUserMessage(`消息${i}`.repeat(50)))
    const ctx = createAgentContext({ initialMessages: messages })
    const before = JSON.stringify((await ctx.getSnapshot()).messages)

    await assert.rejects(async () => {
      await maybeCompactConversation(ctx, {
        summarize: async () => {
          throw new Error('LLM summarizer down')
        },
        triggerTokens: 100,
      })
    })

    const after = JSON.stringify((await ctx.getSnapshot()).messages)
    assert.equal(after, before)
  })

  test('messages 包含 model role 时也走压缩,不退化为文本拼接', async () => {
    const initial: AgentMessage[] = []
    for (let i = 0; i < 15; i++) {
      initial.push(makeUserMessage(`用户${i}: 你好你好你好你好你好你好你好你好`))
      initial.push(makeModelMessage(`回复${i}: 嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯`))
    }
    const ctx = createAgentContext({ initialMessages: initial })
    const summarizeCalls: SummarizeInput[] = []

    await maybeCompactConversation(ctx, {
      summarize: captureSummarize({ output: '聊了 15 轮', capture: { calls: summarizeCalls } }),
      triggerTokens: 100,
      keepRatio: 0.2,
    })

    // summarize 收到的 history 里 user/model 形态保留 (不是文本拼接)
    const history = summarizeCalls[0]?.history ?? []
    const userCount = history.filter((m) => m.role === 'user').length
    const modelCount = history.filter((m) => m.role === 'model').length
    assert.ok(userCount > 0)
    assert.ok(modelCount > 0)
  })
})
