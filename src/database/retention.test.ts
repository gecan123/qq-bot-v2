import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { purgeOldData, type RetentionStore } from './retention.js'

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
    }
    const now = new Date(2026, 6, 16, 12, 30)

    await purgeOldData({ now: () => now, store })

    const expectedCutoff = new Date(2026, 6, 9)
    assert.deepEqual(calls, [
      { operation: 'list-protected' },
      { operation: 'delete-messages', cutoff: expectedCutoff },
      { operation: 'delete-media', cutoff: expectedCutoff, protectedIds: [11, 22] },
    ])
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
    }

    await assert.rejects(
      purgeOldData({ now: () => new Date(2026, 6, 16), store }),
      /message cleanup failed/,
    )
    assert.equal(mediaCleanupStarted, false)
  })
})
