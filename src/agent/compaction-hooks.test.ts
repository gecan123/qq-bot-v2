import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ReadyCompactionPreparation } from './compaction.js'
import type { CompactionAgentLedgerEntry } from './agent-ledger.types.js'
import { runAfterCompactHook, runBeforeCompactHook } from './compaction-hooks.js'

describe('compaction hooks', () => {
  test('beforeCompact can continue, cancel, or provide a custom summary', async () => {
    const event = {
      preparation: {} as ReadyCompactionPreparation,
      reason: 'manual' as const,
      manualFocus: 'tools',
      signal: new AbortController().signal,
    }

    assert.deepEqual(await runBeforeCompactHook({}, event), { action: 'continue' })
    assert.deepEqual(await runBeforeCompactHook({
      beforeCompact: async () => ({ action: 'cancel', reason: 'operator cancelled' }),
    }, event), { action: 'cancel', reason: 'operator cancelled' })
    assert.deepEqual(await runBeforeCompactHook({
      beforeCompact: async () => ({ action: 'use_summary', summary: 'custom' }),
    }, event), { action: 'use_summary', summary: 'custom' })
  })

  test('afterCompact is a best-effort post-commit notification', async () => {
    const committedEntry = { id: 9n, entryType: 'compaction' } as CompactionAgentLedgerEntry
    const errors: Error[] = []
    let calls = 0

    const result = await runAfterCompactHook({
      afterCompact: async (event: { committedEntry: unknown }) => {
        calls += 1
        assert.equal(event.committedEntry, committedEntry)
        throw new Error('metrics backend unavailable')
      },
    }, {
      committedEntry,
      metrics: { tokensBefore: 100, estimatedTokensAfter: 20 },
    }, (error) => { errors.push(error) })

    assert.equal(calls, 1)
    assert.equal(errors[0]?.message, 'metrics backend unavailable')
    assert.deepEqual(result, { ok: false, error: errors[0] })
  })

  test('afterCompact also contains failures from its error reporter', async () => {
    const committedEntry = { id: 9n, entryType: 'compaction' } as CompactionAgentLedgerEntry

    const result = await runAfterCompactHook({
      afterCompact: async () => { throw new Error('hook failed') },
    }, {
      committedEntry,
      metrics: { tokensBefore: 100, estimatedTokensAfter: 20 },
    }, () => { throw new Error('logger failed') })

    assert.equal(result.ok, false)
  })
})
