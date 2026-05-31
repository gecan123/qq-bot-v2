import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBrowserActionLogEntry, logBrowserAction } from './action-log.js'

describe('browser action log', () => {
  it('redacts sensitive args in summaries', () => {
    const entry = buildBrowserActionLogEntry({
      startedAt: Date.now(),
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      action: { action: 'type', text: '123456', elementId: 'password' },
      result: { ok: false, action: 'type', code: 'requires_owner_help', risk: 'high' },
    })
    assert.equal(entry.ts, '2026-06-01T00:00:00.000Z')
    assert.deepEqual(entry.argsSummary, { action: 'type', text: '123456', elementId: 'password' })
  })

  it('swallows append failures', async () => {
    await assert.doesNotReject(() => logBrowserAction({
      ts: '2026-06-01T00:00:00.000Z',
      action: 'status',
      argsSummary: {},
      ok: true,
      durationMs: 1,
    }, {
      appender: async () => {
        throw new Error('disk full')
      },
    }))
  })
})
