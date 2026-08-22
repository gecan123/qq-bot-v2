import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  beijingStartOfDayDaysAgo,
  purgeOldData,
  type RetentionStore,
} from './retention.js'

describe('purgeOldData', () => {
  test('runs large message and media cleanup as ordered independent operations', async () => {
    const calls: Array<{
      operation: string
      cutoff?: Date
      protectedIds?: number[]
    }> = []
    const store: RetentionStore = {
      async listProtectedMediaIds() {
        calls.push({ operation: 'list-protected' })
        return [11, 22]
      },
      async deleteMessagesBefore(cutoff) {
        calls.push({ operation: 'delete-messages', cutoff })
        return 3676
      },
      async deleteMediaBefore(cutoff, protectedIds) {
        calls.push({ operation: 'delete-media', cutoff, protectedIds })
        return 1074
      },
      async deleteOrphanBlobsBefore(cutoff) {
        calls.push({ operation: 'delete-orphan-blobs', cutoff })
        return 321
      },
    }
    const now = new Date('2026-07-16T04:30:00.000Z')

    await purgeOldData({ now: () => now, store })

    const expectedCutoff = new Date('2026-07-08T16:00:00.000Z')
    assert.deepEqual(calls, [
      { operation: 'list-protected' },
      { operation: 'delete-messages', cutoff: expectedCutoff },
      { operation: 'delete-media', cutoff: expectedCutoff, protectedIds: [11, 22] },
      {
        operation: 'delete-orphan-blobs',
        cutoff: new Date(now.getTime() - 60 * 60 * 1_000),
      },
    ])
  })

  test('uses a caller-provided inbound retention window', async () => {
    let messageCutoff: Date | undefined
    const store: RetentionStore = {
      async listProtectedMediaIds() { return [] },
      async deleteMessagesBefore(cutoff) {
        messageCutoff = cutoff
        return 0
      },
      async deleteMediaBefore() { return 0 },
      async deleteOrphanBlobsBefore() { return 0 },
    }

    await purgeOldData({
      now: () => new Date('2026-07-16T04:30:00.000Z'),
      retentionDays: 30,
      store,
    })

    assert.deepEqual(messageCutoff, new Date('2026-06-15T16:00:00.000Z'))
  })

  test('calculates the retention boundary in Beijing regardless of process timezone', () => {
    assert.deepEqual(
      beijingStartOfDayDaysAgo(new Date('2026-07-16T15:59:59.999Z'), 7),
      new Date('2026-07-08T16:00:00.000Z'),
    )
    assert.deepEqual(
      beijingStartOfDayDaysAgo(new Date('2026-07-16T16:00:00.000Z'), 7),
      new Date('2026-07-09T16:00:00.000Z'),
    )
  })

  test('does not start media cleanup before message cleanup succeeds', async () => {
    let mediaCleanupStarted = false
    const store: RetentionStore = {
      async listProtectedMediaIds() { return [] },
      async deleteMessagesBefore() { throw new Error('message cleanup failed') },
      async deleteMediaBefore() {
        mediaCleanupStarted = true
        return 0
      },
      async deleteOrphanBlobsBefore() { return 0 },
    }

    await assert.rejects(
      purgeOldData({ now: () => new Date(2026, 6, 16), store }),
      /message cleanup failed/,
    )
    assert.equal(mediaCleanupStarted, false)
  })
})
