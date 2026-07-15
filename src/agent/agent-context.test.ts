import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentContext } from './agent-context.js'
import type { AgentMessage, ClaudeAssistantNativeBlock } from './agent-context.types.js'
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
    ctx1.activateToolCapability('browser')
    ctx1.activateToolCapability('media_generation')

    const persisted = ctx1.exportPersistedSnapshot()
    assert.equal(persisted.schemaVersion, SNAPSHOT_SCHEMA_VERSION)
    assert.equal(persisted.messages.length, 3)
    assert.deepEqual(persisted.activeToolCapabilities, ['browser', 'media_generation'])

    const ctx2 = createAgentContext()
    ctx2.restorePersistedSnapshot(persisted)
    assert.deepEqual(ctx2.getSnapshot(), {
      messages: persisted.messages,
      activeToolCapabilities: ['browser', 'media_generation'],
      qqConversationFocus: null,
    })
    ctx2.deactivateToolCapability('browser')
    assert.deepEqual(ctx2.getSnapshot().activeToolCapabilities, ['media_generation'])
  })

  test('QQ conversation focus is cloned, persisted, restored, and survives message replacement', () => {
    const ctx = createAgentContext()
    const focus = { type: 'group' as const, groupId: 123 }

    ctx.setQqConversationFocus(focus)
    focus.groupId = 456
    assert.deepEqual(ctx.getSnapshot().qqConversationFocus, { type: 'group', groupId: 123 })

    const snapshot = ctx.getSnapshot()
    if (snapshot.qqConversationFocus?.type === 'group') {
      snapshot.qqConversationFocus.groupId = 789
    }
    assert.deepEqual(ctx.getSnapshot().qqConversationFocus, { type: 'group', groupId: 123 })

    const persisted = ctx.exportPersistedSnapshot()
    const restored = createAgentContext()
    restored.restorePersistedSnapshot(persisted)
    assert.deepEqual(restored.getSnapshot().qqConversationFocus, { type: 'group', groupId: 123 })

    restored.replaceMessages([{ role: 'user', content: 'summary' }])
    assert.deepEqual(restored.getSnapshot().qqConversationFocus, { type: 'group', groupId: 123 })

    restored.setQqConversationFocus(null)
    assert.equal(restored.getSnapshot().qqConversationFocus, null)
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

  test('cloning isolates nested assistant tool call args', () => {
    const ctx = createAgentContext()
    const callArgs = { target: { groupId: '123' }, payload: { text: 'hi' } }
    ctx.appendAssistantTurn({
      content: '',
      toolCalls: [{ id: '1', name: 'send_message', args: callArgs }],
    })

    callArgs.target.groupId = 'mutated'
    callArgs.payload.text = 'changed'

    const messages = ctx.getSnapshot().messages
    const turn = messages[0]
    if (turn && turn.role === 'assistant') {
      assert.deepEqual(turn.toolCalls[0]?.args, {
        target: { groupId: '123' },
        payload: { text: 'hi' },
      })
    } else {
      assert.fail('expected assistant turn')
    }
  })

  test('cloning isolates assistant native blocks', () => {
    const ctx = createAgentContext()
    const nativeBlocks: ClaudeAssistantNativeBlock[] = [
      { type: 'thinking', thinking: 'plan', signature: 'sig', extra: { nested: 'value' } },
    ]

    ctx.appendAssistantTurn({
      content: '',
      toolCalls: [],
      nativeBlocks,
    })

    ;(nativeBlocks[0]!.extra as { nested: string }).nested = 'mutated'

    const expectedNativeBlocks = [
      { type: 'thinking', thinking: 'plan', signature: 'sig', extra: { nested: 'value' } },
    ]
    const snapshot = ctx.getSnapshot()
    const turn = snapshot.messages[0]
    if (turn && turn.role === 'assistant') {
      assert.deepEqual(turn.nativeBlocks, expectedNativeBlocks)
      ;(turn.nativeBlocks![0]!.extra as { nested: string }).nested = 'snapshot mutation'
    } else {
      assert.fail('expected assistant turn')
    }

    const freshSnapshot = ctx.getSnapshot()
    const freshTurn = freshSnapshot.messages[0]
    if (freshTurn && freshTurn.role === 'assistant') {
      assert.deepEqual(freshTurn.nativeBlocks, expectedNativeBlocks)
    } else {
      assert.fail('expected assistant turn')
    }
  })
})
