import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentContext } from './agent-context.js'
import type { AgentMessage } from './agent-context.types.js'
import { SNAPSHOT_SCHEMA_VERSION } from './agent-context.types.js'

describe('createAgentContext', () => {
  test('starts empty and getSnapshot returns deep copy', () => {
    const ctx = createAgentContext()
    const snap = ctx.getSnapshot()
    assert.deepEqual(snap.messages, [])
    ;(snap.messages as AgentMessage[]).push({ role: 'user', content: 'hijack' })
    assert.deepEqual(ctx.getSnapshot().messages, [], 'mutation of returned snapshot must not affect internal state')
  })

  test('appendUserMessage / appendAssistantTurn / appendToolResult build sane history', () => {
    // Note: 'send_group_message' here is the historical (MVP-1) tool name, retained in this
    // fixture to represent a snapshot persisted under the old name. After MVP-2 rename, real
    // bot snapshots will store 'send_message' instead, but already-persisted history is
    // immutable (red line 5 byte stability) so the old name stays in production rows too.
    const ctx = createAgentContext()
    ctx.appendUserMessage('张三: 在吗')
    ctx.appendAssistantTurn({
      content: '思考: 该回复',
      toolCalls: [
        { id: 'call_1', name: 'send_group_message', args: { text: '在' } },
      ],
    })
    ctx.appendToolResult({ toolCallId: 'call_1', content: '{"ok":true}' })

    const messages = ctx.getSnapshot().messages
    assert.equal(messages.length, 3)
    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[1]?.role, 'assistant')
    assert.equal(messages[2]?.role, 'tool')

    const tool = messages[2]
    if (tool && tool.role === 'tool') {
      assert.equal(tool.toolCallId, 'call_1')
      assert.equal(tool.content, '{"ok":true}')
    }
  })

  test('replaceMessages atomically resets the array', () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('a')
    ctx.appendUserMessage('b')
    ctx.replaceMessages([{ role: 'user', content: 'summary' }])
    const messages = ctx.getSnapshot().messages
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.role, 'user')
  })

  test('exportPersistedSnapshot includes schemaVersion and is round-trippable', () => {
    const ctx1 = createAgentContext()
    ctx1.appendUserMessage('hello')
    ctx1.appendAssistantTurn({ content: '', toolCalls: [{ id: 'c1', name: 'wait', args: {} }] })
    ctx1.appendToolResult({ toolCallId: 'c1', content: 'ok' })

    const persisted = ctx1.exportPersistedSnapshot()
    assert.equal(persisted.schemaVersion, SNAPSHOT_SCHEMA_VERSION)
    assert.equal(persisted.messages.length, 3)

    const ctx2 = createAgentContext()
    ctx2.restorePersistedSnapshot(persisted)
    assert.deepEqual(ctx2.getSnapshot().messages, persisted.messages)
  })

  test('cloning isolates assistant tool call args', () => {
    const ctx = createAgentContext()
    const callArgs = { text: 'hi' }
    ctx.appendAssistantTurn({
      content: '',
      toolCalls: [{ id: '1', name: 'send_group_message', args: callArgs }],
    })
    callArgs.text = 'mutated'
    const messages = ctx.getSnapshot().messages
    const turn = messages[0]
    if (turn && turn.role === 'assistant') {
      assert.equal(turn.toolCalls[0]?.args['text'], 'hi', 'context must clone tool call args at append time')
    } else {
      assert.fail('expected assistant turn')
    }
  })
})
