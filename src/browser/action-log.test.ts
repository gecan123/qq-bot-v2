import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBrowserActionLogEntry, logBrowserAction } from './action-log.js'

describe('browser action log', () => {
  it('redacts typed text for high-risk browser actions', () => {
    const entry = buildBrowserActionLogEntry({
      startedAt: Date.now(),
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      action: { action: 'type', text: '123456', elementId: 'password' },
      result: { ok: false, action: 'type', code: 'requires_owner_help', risk: 'high' },
    })
    assert.equal(entry.ts, '2026-06-01T00:00:00.000Z')
    assert.deepEqual(entry.argsSummary, { action: 'type', text: '[REDACTED]', elementId: 'password' })
  })

  it('keeps ordinary typed text in summaries', () => {
    const entry = buildBrowserActionLogEntry({
      startedAt: Date.now(),
      now: () => new Date('2026-06-01T00:00:00.000Z'),
      action: { action: 'type', text: 'hello', elementId: 'comment-box' },
      result: { ok: true, action: 'type', risk: 'normal' },
    })
    assert.deepEqual(entry.argsSummary, { action: 'type', text: 'hello', elementId: 'comment-box' })
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
