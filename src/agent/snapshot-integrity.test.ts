import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SNAPSHOT_SCHEMA_VERSION, type PersistedAgentSnapshot } from './agent-context.types.js'
import { validateBotSnapshotIntegrity } from './snapshot-integrity.js'

describe('validateBotSnapshotIntegrity', () => {
  test('accepts a well-formed persisted snapshot and mailbox cursors', () => {
    const snapshot: PersistedAgentSnapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      activeToolCapabilities: ['external_research'],
      messages: [
        { role: 'user', content: '{"event":"inbox_update"}' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'inbox', args: { action: 'list' } }],
        },
        { role: 'tool', toolCallId: 'call-1', content: '{"ok":true}' },
      ],
    }

    const result = validateBotSnapshotIntegrity({
      snapshot,
      mailboxCursors: { 'qq_group:1001': 10, 'qq_private:2002': 3 },
    })

    assert.deepEqual(result, {
      ok: true,
      errors: [],
      warnings: [],
      stats: {
        messages: 3,
        assistantToolCalls: 1,
        toolResults: 1,
        activeToolCapabilities: 1,
        mailboxCursors: 2,
      },
    })
  })

  test('rejects assistant tool calls without adjacent matching tool results', () => {
    const result = validateBotSnapshotIntegrity({
      snapshot: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        activeToolCapabilities: [],
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'lookup', args: {} }],
          },
          { role: 'user', content: 'interleaved' },
        ],
      },
      mailboxCursors: {},
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /messages\[1\] must be tool result for assistant tool call call-1/)
  })

  test('rejects invalid mailbox cursors, orphan tool results, and invalid JSON-like tool content', () => {
    const result = validateBotSnapshotIntegrity({
      snapshot: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        activeToolCapabilities: [],
        messages: [
          { role: 'tool', toolCallId: 'orphan', content: '{"ok":true}' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'lookup', args: {} }],
          },
          { role: 'tool', toolCallId: 'call-1', content: '{"ok":' },
        ],
      },
      mailboxCursors: { 'bad-key': -1 },
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /messages\[0\] is orphan tool result/)
    assert.match(result.errors.join('\n'), /messages\[2\] tool JSON content is invalid/)
    assert.match(result.errors.join('\n'), /mailboxCursors\.bad-key has invalid key/)
    assert.match(result.errors.join('\n'), /mailboxCursors\.bad-key must be a non-negative safe integer/)
  })

  test('rejects duplicate tool results after a matched assistant tool call', () => {
    const result = validateBotSnapshotIntegrity({
      snapshot: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        activeToolCapabilities: [],
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'lookup', args: {} }],
          },
          { role: 'tool', toolCallId: 'call-1', content: '{"ok":true}' },
          { role: 'tool', toolCallId: 'call-1', content: '{"ok":true}' },
        ],
      },
      mailboxCursors: {},
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /messages\[2\] is duplicate tool result call-1/)
  })
})
