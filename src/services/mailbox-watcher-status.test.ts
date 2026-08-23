import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  initialMailboxWatcherStatus,
  recordMailboxWatcherFailure,
  recordMailboxWatcherSuccess,
  shouldPublishMailboxWatcherStatus,
} from './mailbox-watcher-status.js'

describe('mailbox watcher status', () => {
  test('tracks repeated poison-row failures without advancing the cursor', () => {
    const started = initialMailboxWatcherStatus(40, new Date('2026-08-23T00:00:00Z'))
    const first = recordMailboxWatcherFailure(
      started,
      41,
      Object.assign(new Error('bad row'), { code: 'INVALID_ROW' }),
      new Date('2026-08-23T00:00:01Z'),
    )
    const second = recordMailboxWatcherFailure(
      first,
      41,
      Object.assign(new Error('bad row'), { code: 'INVALID_ROW' }),
      new Date('2026-08-23T00:00:02Z'),
    )
    assert.equal(second.cursor, 40)
    assert.equal(second.blockedAtRowId, 41)
    assert.equal(second.consecutiveFailures, 2)
    assert.equal(second.lastErrorKind, 'INVALID_ROW')
  })

  test('clears stalled state after the row succeeds', () => {
    const failed = recordMailboxWatcherFailure(initialMailboxWatcherStatus(40), 41, new TypeError('bad'))
    assert.deepEqual(recordMailboxWatcherSuccess(failed, 41).blockedAtRowId, null)
    assert.equal(recordMailboxWatcherSuccess(failed, 41).consecutiveFailures, 0)
  })

  test('publishes changes immediately but throttles unchanged heartbeat writes', () => {
    const previous = initialMailboxWatcherStatus(40, new Date('2026-08-23T00:00:00Z'))
    const unchanged = recordMailboxWatcherSuccess(previous, 40, new Date('2026-08-23T00:00:01Z'))
    assert.equal(shouldPublishMailboxWatcherStatus({
      current: unchanged, previous, lastPublishedAtMs: 0, nowMs: 1_000, heartbeatMs: 60_000,
    }), false)
    assert.equal(shouldPublishMailboxWatcherStatus({
      current: unchanged, previous, lastPublishedAtMs: 0, nowMs: 60_000, heartbeatMs: 60_000,
    }), true)
    const advanced = recordMailboxWatcherSuccess(previous, 41, new Date('2026-08-23T00:00:01Z'))
    assert.equal(shouldPublishMailboxWatcherStatus({
      current: advanced, previous, lastPublishedAtMs: 0, nowMs: 1_000, heartbeatMs: 60_000,
    }), true)
    const firstFailure = recordMailboxWatcherFailure(previous, 41, new TypeError('bad'), new Date('2026-08-23T00:00:01Z'))
    const repeatedFailure = recordMailboxWatcherFailure(firstFailure, 41, new TypeError('bad'), new Date('2026-08-23T00:00:02Z'))
    assert.equal(shouldPublishMailboxWatcherStatus({
      current: repeatedFailure, previous: firstFailure, lastPublishedAtMs: 1_000, nowMs: 2_000, heartbeatMs: 60_000,
    }), false)
  })
})
