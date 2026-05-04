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
  // [user, user, user, user, user] keep last 2 → cut=3, before=user, headOfTail=user, safe
  const msgs: AgentMessage[] = [user('1'), user('2'), user('3'), user('4'), user('5')]
  assert.equal(findSafeCutIndex(msgs, 2), 3)
})

test('findSafeCutIndex: clean cut after assistant without toolCalls', () => {
  // ... user, asst (no tools), user, user — cut between asst and user is safe
  const msgs: AgentMessage[] = [user('1'), asst('hi'), user('2'), user('3')]
  // keepCount=2 → cut=2; before=asst (toolCalls empty), headOfTail=user → safe
  assert.equal(findSafeCutIndex(msgs, 2), 2)
})

test('findSafeCutIndex: cut would land ON a tool message → walks back to before its anchor', () => {
  // [user, asst(tools=[a,b]), tool_a, tool_b, user]
  // keepCount=3 → initial cut=2 (messages[2]=tool_a). Need to push back past assistant.
  const msgs: AgentMessage[] = [
    user('hello'),
    asst('thinking', [{ id: 'a', name: 'wait' }, { id: 'b', name: 'db_read' }]),
    tool('a'),
    tool('b'),
    user('next'),
  ]
  // At cut=2: head=tool → cut=1
  // At cut=1: head=asst, before(=msgs[0])=user → safe
  assert.equal(findSafeCutIndex(msgs, 3), 1)
})

test('findSafeCutIndex: cut would split assistant-with-toolCalls block (cut-1 is assistant) → walks back', () => {
  // [user, user, asst(tools=[a]), tool_a, user]
  // keepCount=2 → initial cut=3 (messages[3]=tool_a, before=asst+tools).
  // Push back: cut=3→head=tool→cut=2; cut=2→head=asst, before=user→safe.
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
  // [user, asst(tools=[a,b,c]), tool_a, tool_b, tool_c, user, user]
  // keepCount=3 → cut=4 (messages[4]=tool_c). Walk:
  //   cut=4: head=tool → cut=3
  //   cut=3: head=tool → cut=2
  //   cut=2: head=tool → cut=1
  //   cut=1: head=asst, before=user → safe
  const msgs: AgentMessage[] = [
    user('hi'),
    asst('working', [
      { id: 'a', name: 'wait' },
      { id: 'b', name: 'db_read' },
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
  // Reproduces the bug we just fixed.
  // [user, asst(tools=[x]), tool_x, user, user]
  // keepCount=2 → cut=3 (head=user, before=tool). Wait, cut-1 is messages[2]=tool, not assistant.
  // Old code: before.role==='assistant' fails → cut=3 returned. tail = [user, user]. SAFE actually.
  //
  // Real bug case: keepCount=1 → cut=4 (head=user). Tail=[user]. Old code: before=tool → fails, returns 4. Safe too.
  //
  // The bug is when tool result IS in the tail. Try: keepCount=2 with longer tool seq:
  // [user, asst(tools=[a,b]), tool_a, tool_b, more...] keepCount=1 from a length-4 array:
  // length=4, cut=3, head=tool_b. Old code: before=tool_a → not assistant → returns 3. Tail=[tool_b]. ORPHAN BUG.
  const msgs: AgentMessage[] = [
    user('hi'),
    asst('thinking', [{ id: 'a', name: 'wait' }, { id: 'b', name: 'db_read' }]),
    tool('a'),
    tool('b'),
  ]
  // Initial cut = 4-1 = 3. messages[3]=tool_b. Old code returned 3 → orphan tool_b in tail.
  // New code walks: cut=3 head=tool → cut=2 head=tool → cut=1 head=asst before=user → safe.
  assert.equal(findSafeCutIndex(msgs, 1), 1)
})

test('findSafeCutIndex: degenerate all-tool tail walks all the way to 0', () => {
  // No safe boundary exists short of returning 0 (nothing compressed).
  const msgs: AgentMessage[] = [
    asst('start', [{ id: 'a', name: 'wait' }]),
    tool('a'),
    tool('b'),
    tool('c'),
  ]
  // cut=3: head=tool → 2; cut=2: head=tool → 1; cut=1: head=tool → 0; return 0.
  assert.equal(findSafeCutIndex(msgs, 1), 0)
})

test('findSafeCutIndex: consecutive assistant+toolCalls blocks both kept', () => {
  // [user, asst1(tools=[a]), tool_a, asst2(tools=[b]), tool_b, user]
  // keepCount=3 → initial cut=3 (messages[3]=asst2, before=tool_a).
  //   cut=3: head=asst2, before=tool_a (not assistant w/ toolCalls — it's a tool message). break. cut=3.
  // But wait — messages[2]=tool_a, messages[3]=asst2. tool_a's anchor is asst1 at index 1.
  // If we cut at 3, compressed=[user, asst1, tool_a]. Kept=[asst2, tool_b, user]. asst2 has tool_b in tail. SAFE.
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

test('maybeCompactConversation: under threshold → no-op', async () => {
  const ctx = createAgentContext()
  ctx.appendUserMessage('hi')

  let calls = 0
  await maybeCompactConversation(ctx, {
    triggerTokens: 1_000_000, // never triggers
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
  // Pump enough messages to cross a tiny threshold.
  for (let i = 0; i < 30; i++) ctx.appendUserMessage(`msg-${i}-with-some-content-for-tokens`)

  await maybeCompactConversation(ctx, {
    triggerTokens: 10, // immediate trigger
    keepRatio: 0.1,
    summarize: async () => 'compressed-summary',
  })

  const after = ctx.getSnapshot().messages
  assert.ok(after.length < 30, 'should have compressed')
  assert.equal(after[0]?.role, 'user')
  assert.match((after[0] as { content: string }).content, /^\[历史摘要\]/)
  assert.match((after[0] as { content: string }).content, /compressed-summary/)
})

test('maybeCompactConversation: empty summary skipped, no replace', async () => {
  const ctx = createAgentContext()
  for (let i = 0; i < 20; i++) ctx.appendUserMessage(`msg-${i}-padding-for-tokens`)
  const before = ctx.getSnapshot().messages.length

  await maybeCompactConversation(ctx, {
    triggerTokens: 10,
    summarize: async () => '   ', // whitespace only
  })

  assert.equal(ctx.getSnapshot().messages.length, before)
})

test('maybeCompactConversation: kept tail never starts with orphan tool message', async () => {
  // Scenario that would have produced an orphan with the old findSafeCutIndex:
  // many user messages, then asst(toolCalls=[a,b]), tool_a, tool_b at the very end.
  const ctx = createAgentContext()
  for (let i = 0; i < 25; i++) ctx.appendUserMessage(`m${i}-with-some-padding`)
  ctx.appendAssistantTurn({
    content: 'thinking',
    toolCalls: [
      { id: 'a', name: 'wait', args: {} },
      { id: 'b', name: 'db_read', args: {} },
    ],
  })
  ctx.appendToolResult({ toolCallId: 'a', content: 'ok' })
  ctx.appendToolResult({ toolCallId: 'b', content: 'ok' })

  await maybeCompactConversation(ctx, {
    triggerTokens: 10,
    keepRatio: 0.05, // small tail — would land on tool with old code
    summarize: async () => 'sm',
  })

  const after = ctx.getSnapshot().messages
  // Tail must not begin with a tool message (head is always the synthetic [历史摘要] user).
  assert.equal(after[0]?.role, 'user')
  // Whatever message follows the summary must not be an orphan tool.
  // "Orphan" = tool whose toolCallId's anchoring assistant turn is not also in the tail.
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
