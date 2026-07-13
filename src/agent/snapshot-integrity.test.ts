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
      mailboxContinuity: {
        schemaVersion: 1,
        roundSeq: 12,
        lastInputTokens: 20_000,
        compactionEpoch: 1,
        mailboxes: {
          'qq_private:2002': {
            lastMessageAtMs: 1_700_000_000_000,
            roundSeq: 10,
            inputTokens: 10_000,
            compactionEpoch: 1,
          },
        },
      },
      goalRevision: 4,
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
        goalRevision: 4,
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
      goalRevision: 0,
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
      goalRevision: -1,
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /messages\[0\] is orphan tool result/)
    assert.match(result.errors.join('\n'), /messages\[2\] tool JSON content is invalid/)
    assert.match(result.errors.join('\n'), /mailboxCursors\.bad-key has invalid key/)
    assert.match(result.errors.join('\n'), /mailboxCursors\.bad-key must be a non-negative safe integer/)
    assert.match(result.errors.join('\n'), /goalRevision must be a non-negative safe integer/)
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
      goalRevision: 0,
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /messages\[2\] is duplicate tool result call-1/)
  })

  test('rejects malformed mailbox continuity metadata', () => {
    const result = validateBotSnapshotIntegrity({
      snapshot: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        activeToolCapabilities: [],
        messages: [],
      },
      mailboxCursors: {},
      mailboxContinuity: {
        roundSeq: -1,
        lastInputTokens: 'many',
        compactionEpoch: 0,
        mailboxes: { bad: {} },
      },
      goalRevision: 0,
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /mailboxContinuity\.roundSeq/)
    assert.match(result.errors.join('\n'), /mailboxContinuity\.lastInputTokens/)
    assert.match(result.errors.join('\n'), /mailboxContinuity\.mailboxes\.bad has invalid key/)
  })

  test('reports malformed message fields instead of throwing inside the validator', () => {
    const malformed = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      activeToolCapabilities: [],
      messages: [{ role: 'user', content: 42 }],
    } as unknown as PersistedAgentSnapshot

    const result = validateBotSnapshotIntegrity({
      snapshot: malformed,
      mailboxCursors: {},
      goalRevision: 0,
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /messages\[0\]\.content must be a string/)
  })
})
