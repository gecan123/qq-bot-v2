import test from 'node:test'
import assert from 'node:assert/strict'

import { createAgentContext } from './agent-context.js'
import type { AgentMessage } from './agent-context.types.js'
import { findSafeCutIndex, maybeCompactConversation } from './compaction.js'

function user(content: string): AgentMessage {
  return { role: 'user', content }
}

function asst(content: string, toolCalls: { id: string; name: string }[] = []): AgentMessage {
  return {
    role: 'assistant',
    content,
    toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, args: {} })),
  }
}

function asstWithThinking(
  content: string,
  toolCalls: { id: string; name: string }[] = [],
): AgentMessage {
  return {
    role: 'assistant',
    content,
    nativeBlocks: [{ type: 'thinking', thinking: 'raw private thought', signature: 'sig' }],
    toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, args: {} })),
  }
}

function tool(toolCallId: string, content = 'ok'): AgentMessage {
  return { role: 'tool', toolCallId, content }
}

test('findSafeCutIndex: empty messages → 0', () => {
  assert.equal(findSafeCutIndex([], 1), 0)
})

test('findSafeCutIndex: messages.length <= keepCount → 0', () => {
  const msgs: AgentMessage[] = [user('a'), user('b')]
  assert.equal(findSafeCutIndex(msgs, 5), 0)
})

test('findSafeCutIndex: clean cut at user boundary', () => {
  const msgs: AgentMessage[] = [user('1'), user('2'), user('3'), user('4'), user('5')]
  assert.equal(findSafeCutIndex(msgs, 2), 3)
})

test('findSafeCutIndex: clean cut after assistant without toolCalls', () => {
  const msgs: AgentMessage[] = [user('1'), asst('hi'), user('2'), user('3')]
  assert.equal(findSafeCutIndex(msgs, 2), 2)
})

test('findSafeCutIndex: cut would land ON a tool message → walks back to before its anchor', () => {
  const msgs: AgentMessage[] = [
    user('hello'),
    asst('thinking', [{ id: 'a', name: 'wait' }, { id: 'b', name: 'db' }]),
    tool('a'),
    tool('b'),
    user('next'),
  ]
  assert.equal(findSafeCutIndex(msgs, 3), 1)
})

test('findSafeCutIndex: cut would split assistant-with-toolCalls block (cut-1 is assistant) → walks back', () => {
  const msgs: AgentMessage[] = [
    user('1'),
    user('2'),
    asst('think', [{ id: 'a', name: 'wait' }]),
    tool('a'),
    user('3'),
  ]
  assert.equal(findSafeCutIndex(msgs, 2), 2)
})

test('findSafeCutIndex: cut in middle of multi-tool-result sequence → walks back to before anchor', () => {
  const msgs: AgentMessage[] = [
    user('hi'),
    asst('working', [
      { id: 'a', name: 'wait' },
      { id: 'b', name: 'db' },
      { id: 'c', name: 'send_message' },
    ]),
    tool('a'),
    tool('b'),
    tool('c'),
    user('after'),
    user('more'),
  ]
  assert.equal(findSafeCutIndex(msgs, 3), 1)
})

test('findSafeCutIndex: kept tail starting with tool whose anchor was already compressed → push back', () => {
  const msgs: AgentMessage[] = [
    user('hi'),
    asst('thinking', [{ id: 'a', name: 'wait' }, { id: 'b', name: 'db' }]),
    tool('a'),
    tool('b'),
  ]
  assert.equal(findSafeCutIndex(msgs, 1), 1)
})

test('findSafeCutIndex: degenerate all-tool tail walks all the way to 0', () => {
  const msgs: AgentMessage[] = [
    asst('start', [{ id: 'a', name: 'wait' }]),
    tool('a'),
    tool('b'),
    tool('c'),
  ]
  assert.equal(findSafeCutIndex(msgs, 1), 0)
})

test('findSafeCutIndex: consecutive assistant+toolCalls blocks both kept', () => {
  const msgs: AgentMessage[] = [
    user('1'),
    asst('a1', [{ id: 'a', name: 'wait' }]),
    tool('a'),
    asst('a2', [{ id: 'b', name: 'send_message' }]),
    tool('b'),
    user('2'),
  ]
  assert.equal(findSafeCutIndex(msgs, 3), 3)
})

// ---------- maybeCompactConversation integration ----------

test('maybeCompactConversation: lastInputTokens null → no-op', async () => {
  const ctx = createAgentContext()
  ctx.appendUserMessage('hi')

  let calls = 0
  await maybeCompactConversation(ctx, null, {
    summarize: async () => {
      calls++
      return 'summary'
    },
  })
  assert.equal(calls, 0)
  assert.equal(ctx.getSnapshot().messages.length, 1)
})

test('maybeCompactConversation: under threshold → no-op', async () => {
  const ctx = createAgentContext()
  ctx.appendUserMessage('hi')

  let calls = 0
  await maybeCompactConversation(ctx, 50, {
    triggerTokens: 1_000_000,
    summarize: async () => {
      calls++
      return 'summary'
    },
  })
  assert.equal(calls, 0)
  assert.equal(ctx.getSnapshot().messages.length, 1)
})

test('maybeCompactConversation: above threshold → replaces with [summary, ...tail]', async () => {
  const ctx = createAgentContext()
  for (let i = 0; i < 30; i++) ctx.appendUserMessage(`msg-${i}-with-some-content-for-tokens`)

  await maybeCompactConversation(ctx, 50_000, {
    triggerTokens: 10,
    keepRatio: 0.1,
    summarize: async () => 'compressed-summary',
  })

  const after = ctx.getSnapshot().messages
  assert.ok(after.length < 30, 'should have compressed')
  assert.equal(after[0]?.role, 'user')
  assert.match((after[0] as { content: string }).content, /^\[历史摘要\]/)
  assert.match((after[0] as { content: string }).content, /compressed-summary/)
})

test('maybeCompactConversation: every compressed-prefix message reaches the summarizer', async () => {
  const ctx = createAgentContext()
  for (let i = 0; i < 10; i++) ctx.appendUserMessage(`msg-${i}`)
  let summarizedHistory: AgentMessage[] = []

  await maybeCompactConversation(ctx, 50_000, {
    triggerTokens: 10,
    keepRatio: 0.2,
    summarize: async (input) => {
      summarizedHistory = input.history
      return 'complete summary'
    },
  })

  assert.deepEqual(
    summarizedHistory.map((message) => message.role === 'user' ? message.content : message.role),
    Array.from({ length: 8 }, (_, index) => `msg-${index}`),
  )
})

test('maybeCompactConversation: empty summary skipped, no replace', async () => {
  const ctx = createAgentContext()
  for (let i = 0; i < 20; i++) ctx.appendUserMessage(`msg-${i}-padding-for-tokens`)
  const before = ctx.getSnapshot().messages.length

  await maybeCompactConversation(ctx, 50_000, {
    triggerTokens: 10,
    summarize: async () => '   ',
  })

  assert.equal(ctx.getSnapshot().messages.length, before)
})

test('maybeCompactConversation: kept tail never starts with orphan tool message', async () => {
  const ctx = createAgentContext()
  for (let i = 0; i < 25; i++) ctx.appendUserMessage(`m${i}-with-some-padding`)
  ctx.appendAssistantTurn({
    content: 'thinking',
    toolCalls: [
      { id: 'a', name: 'wait', args: {} },
      { id: 'b', name: 'db', args: {} },
    ],
  })
  ctx.appendToolResult({ toolCallId: 'a', content: 'ok' })
  ctx.appendToolResult({ toolCallId: 'b', content: 'ok' })

  await maybeCompactConversation(ctx, 50_000, {
    triggerTokens: 10,
    keepRatio: 0.05,
    summarize: async () => 'sm',
  })

  const after = ctx.getSnapshot().messages
  assert.equal(after[0]?.role, 'user')
  const seenAssistantToolCallIds = new Set<string>()
  for (let i = 1; i < after.length; i++) {
    const m = after[i]!
    if (m.role === 'assistant') {
      for (const c of m.toolCalls) seenAssistantToolCallIds.add(c.id)
    } else if (m.role === 'tool') {
      assert.ok(
        seenAssistantToolCallIds.has(m.toolCallId),
        `orphan tool message at index ${i} (toolCallId=${m.toolCallId})`,
      )
    }
  }
})

test('maybeCompactConversation: single-pass only (no multi-pass loop)', async () => {
  const ctx = createAgentContext()
  for (let i = 0; i < 50; i++) ctx.appendUserMessage(`msg-${i}-padding`)

  let summarizeCalls = 0
  await maybeCompactConversation(ctx, 50_000, {
    triggerTokens: 10,
    keepRatio: 0.1,
    summarize: async () => {
      summarizeCalls++
      return 'summary'
    },
  })

  assert.equal(summarizeCalls, 1, 'should call summarize exactly once (single-pass)')
})

test('maybeCompactConversation: summarizer input strips native thinking blocks', async () => {
  const ctx = createAgentContext({
    initialMessages: [
      user('old-0'),
      asstWithThinking('thinking', [{ id: 'a', name: 'wait' }]),
      tool('a'),
      user('old-1'),
      user('old-2'),
      user('tail'),
    ],
  })
  let summarizedHistory: AgentMessage[] = []

  await maybeCompactConversation(ctx, 50_000, {
    triggerTokens: 10,
    keepRatio: 0.2,
    summarize: async (input) => {
      summarizedHistory = input.history
      return 'summary'
    },
  })

  for (const message of summarizedHistory) {
    if (message.role === 'assistant') {
      assert.equal(message.nativeBlocks, undefined)
    }
  }
})

test('maybeCompactConversation: strips stale native thinking from kept closed tool cycles', async () => {
  const ctx = createAgentContext({
    initialMessages: [
      user('old-0'),
      user('old-1'),
      user('old-2'),
      asstWithThinking('closed thinking', [{ id: 'a', name: 'wait' }]),
      tool('a'),
      user('newer message after tool cycle'),
    ],
  })

  await maybeCompactConversation(ctx, 50_000, {
    triggerTokens: 10,
    keepRatio: 0.5,
    summarize: async () => 'summary',
  })

  const assistant = ctx.getSnapshot().messages.find((message) => message.role === 'assistant')
  assert.ok(assistant)
  if (assistant.role === 'assistant') {
    assert.equal(assistant.nativeBlocks, undefined)
  }
})

test('maybeCompactConversation: keeps native thinking for active tool cycle at tail', async () => {
  const ctx = createAgentContext({
    initialMessages: [
      user('old-0'),
      user('old-1'),
      user('old-2'),
      asstWithThinking('active thinking', [{ id: 'a', name: 'wait' }]),
      tool('a'),
    ],
  })

  await maybeCompactConversation(ctx, 50_000, {
    triggerTokens: 10,
    keepRatio: 0.4,
    summarize: async () => 'summary',
  })

  const assistant = ctx.getSnapshot().messages.find((message) => message.role === 'assistant')
  assert.ok(assistant)
  if (assistant.role === 'assistant') {
    assert.deepEqual(assistant.nativeBlocks, [
      { type: 'thinking', thinking: 'raw private thought', signature: 'sig' },
    ])
  }
})
