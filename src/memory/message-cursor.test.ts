import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

async function loadCursorModule(): Promise<Record<string, unknown>> {
  try {
    return await import('./message-cursor.js')
  } catch {
    return {}
  }
}

describe('resolveMemoryRefreshStart', () => {
  test('uses persisted row cursor when present', async () => {
    const mod = await loadCursorModule()
    const resolveMemoryRefreshStart = mod.resolveMemoryRefreshStart as
      | ((params: { lastProcessedMessageRowId: number | null; now?: Date }) => { mode: string; lastProcessedMessageRowId?: number; since?: Date })
      | undefined

    assert.equal(typeof resolveMemoryRefreshStart, 'function')
    assert.deepEqual(resolveMemoryRefreshStart?.({ lastProcessedMessageRowId: 321 }), {
      mode: 'cursor',
      lastProcessedMessageRowId: 321,
    })
  })

  test('falls back to the latest 24 hours when cursor is missing', async () => {
    const mod = await loadCursorModule()
    const resolveMemoryRefreshStart = mod.resolveMemoryRefreshStart as
      | ((params: { lastProcessedMessageRowId: number | null; now?: Date }) => { mode: string; lastProcessedMessageRowId?: number; since?: Date })
      | undefined

    assert.equal(typeof resolveMemoryRefreshStart, 'function')
    const result = resolveMemoryRefreshStart?.({
      lastProcessedMessageRowId: null,
      now: new Date('2026-04-02T12:00:00.000Z'),
    })

    assert.deepEqual(result, {
      mode: 'recovery',
      since: new Date('2026-04-01T12:00:00.000Z'),
    })
  })
})

describe('buildRecoveryWindowWhere', () => {
  test('prefers sentAt and falls back to createdAt inside the recovery window', async () => {
    const mod = await loadCursorModule()
    const buildRecoveryWindowWhere = mod.buildRecoveryWindowWhere as
      | ((since: Date) => Record<string, unknown>)
      | undefined

    assert.equal(typeof buildRecoveryWindowWhere, 'function')
    const since = new Date('2026-04-01T12:00:00.000Z')
    assert.deepEqual(buildRecoveryWindowWhere?.(since), {
      OR: [
        { sentAt: { gte: since } },
        {
          sentAt: null,
          createdAt: { gte: since },
        },
      ],
    })
  })
})
