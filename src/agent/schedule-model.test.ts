import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  computeNextRunAt,
  normalizeScheduleSpec,
  ScheduleModelError,
  type ScheduleErrorCode,
  type ScheduleSpec,
} from './schedule-model.js'

const NOW = new Date('2026-07-14T00:00:00.000Z')

function assertScheduleError(action: () => unknown, code: ScheduleErrorCode): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ScheduleModelError)
    assert.equal(error.code, code)
    return true
  })
}

describe('normalizeScheduleSpec', () => {
  test('normalizes an absolute at timestamp to ISO', () => {
    assert.deepEqual(
      normalizeScheduleSpec({ kind: 'at', at: '2026-07-14T08:01:00+08:00' }, NOW),
      { kind: 'at', at: '2026-07-14T00:01:00.000Z' },
    )
  })

  test('normalizes a relative at delay against the injected clock', () => {
    assert.deepEqual(normalizeScheduleSpec({ kind: 'at', afterSeconds: 90 }, NOW), {
      kind: 'at',
      at: '2026-07-14T00:01:30.000Z',
    })
  })

  test('rejects at times outside the 30-second to 3-day window', () => {
    assertScheduleError(
      () => normalizeScheduleSpec({ kind: 'at', afterSeconds: 29 }, NOW),
      'outside_schedule_window',
    )
    assertScheduleError(
      () => normalizeScheduleSpec({ kind: 'at', afterSeconds: 3 * 24 * 60 * 60 + 1 }, NOW),
      'outside_schedule_window',
    )
  })

  test('accepts at times exactly on both window boundaries', () => {
    assert.deepEqual(normalizeScheduleSpec({ kind: 'at', afterSeconds: 30 }, NOW), {
      kind: 'at',
      at: '2026-07-14T00:00:30.000Z',
    })
    assert.deepEqual(
      normalizeScheduleSpec({ kind: 'at', afterSeconds: 3 * 24 * 60 * 60 }, NOW),
      {
        kind: 'at',
        at: '2026-07-17T00:00:00.000Z',
      },
    )
  })

  test('rejects invalid or ambiguous at input', () => {
    assertScheduleError(
      () => normalizeScheduleSpec({ kind: 'at', at: 'not-a-time' }, NOW),
      'invalid_schedule',
    )
    assertScheduleError(
      () =>
        normalizeScheduleSpec(
          { kind: 'at', at: '2026-07-14T00:01:00.000Z', afterSeconds: 60 },
          NOW,
        ),
      'invalid_schedule',
    )
  })

  test('rejects absolute timestamps without an explicit timezone', () => {
    assertScheduleError(
      () => normalizeScheduleSpec({ kind: 'at', at: '2026-07-14T00:01:00' }, NOW),
      'invalid_schedule',
    )
    assertScheduleError(
      () =>
        normalizeScheduleSpec(
          { kind: 'every', everySeconds: 300, anchorAt: '2026-07-14T00:01:00' },
          NOW,
        ),
      'invalid_schedule',
    )
  })

  test('rejects timestamps whose ISO calendar date does not exist', () => {
    assertScheduleError(
      () => normalizeScheduleSpec({ kind: 'at', at: '2026-02-30T00:01:00Z' }, NOW),
      'invalid_schedule',
    )
    assertScheduleError(
      () =>
        normalizeScheduleSpec(
          { kind: 'every', everySeconds: 300, anchorAt: '2026-02-30T00:01:00Z' },
          NOW,
        ),
      'invalid_schedule',
    )
  })

  test('rejects relative delays that exceed the representable Date range with a stable code', () => {
    assertScheduleError(
      () => normalizeScheduleSpec({ kind: 'at', afterSeconds: Number.MAX_VALUE }, NOW),
      'outside_schedule_window',
    )
  })

  test('normalizes every with a creation-time anchor by default', () => {
    assert.deepEqual(normalizeScheduleSpec({ kind: 'every', everySeconds: 300 }, NOW), {
      kind: 'every',
      everySeconds: 300,
      anchorAt: NOW.toISOString(),
    })
  })

  test('normalizes an explicit every anchor without moving its fixed cadence', () => {
    assert.deepEqual(
      normalizeScheduleSpec(
        { kind: 'every', everySeconds: 600, anchorAt: '2026-07-13T23:57:00Z' },
        NOW,
      ),
      {
        kind: 'every',
        everySeconds: 600,
        anchorAt: '2026-07-13T23:57:00.000Z',
      },
    )
  })

  test('rejects recurring intervals below five minutes', () => {
    assertScheduleError(
      () => normalizeScheduleSpec({ kind: 'every', everySeconds: 299 }, NOW),
      'recurrence_too_frequent',
    )
  })

  test('rejects recurring intervals that cannot produce a representable Date', () => {
    assertScheduleError(
      () => normalizeScheduleSpec({ kind: 'every', everySeconds: Number.MAX_VALUE }, NOW),
      'invalid_schedule',
    )
  })

  test('defaults cron timezone to Asia/Shanghai', () => {
    assert.deepEqual(normalizeScheduleSpec({ kind: 'cron', expression: '0 9 * * *' }, NOW), {
      kind: 'cron',
      expression: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    })
  })

  test('rejects invalid cron expressions and timezones', () => {
    assertScheduleError(
      () => normalizeScheduleSpec({ kind: 'cron', expression: 'not a cron' }, NOW),
      'invalid_schedule',
    )
    assertScheduleError(
      () =>
        normalizeScheduleSpec(
          { kind: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' },
          NOW,
        ),
      'invalid_schedule',
    )
  })

  test('rejects any adjacent cron triggers under five minutes in the next three days', () => {
    assertScheduleError(
      () => normalizeScheduleSpec({ kind: 'cron', expression: '0,1 * * * *' }, NOW),
      'recurrence_too_frequent',
    )
  })
})

describe('computeNextRunAt', () => {
  test('returns an at timestamp only when it is strictly after the cursor', () => {
    const schedule: ScheduleSpec = { kind: 'at', at: '2026-07-14T00:01:00.000Z' }
    assert.equal(
      computeNextRunAt(schedule, new Date('2026-07-14T00:00:59.999Z'))?.toISOString(),
      schedule.at,
    )
    assert.equal(computeNextRunAt(schedule, new Date(schedule.at)), null)
  })

  test('keeps every schedules anchored and returns a point strictly after the cursor', () => {
    const schedule: ScheduleSpec = {
      kind: 'every',
      everySeconds: 300,
      anchorAt: '2026-07-14T00:00:00.000Z',
    }
    assert.equal(
      computeNextRunAt(schedule, new Date('2026-07-14T00:05:00.000Z'))?.toISOString(),
      '2026-07-14T00:10:00.000Z',
    )
    assert.equal(
      computeNextRunAt(schedule, new Date('2026-07-13T23:59:00.000Z'))?.toISOString(),
      schedule.anchorAt,
    )
  })

  test('never returns an invalid Date when every calculation overflows', () => {
    assertScheduleError(
      () =>
        computeNextRunAt(
          {
            kind: 'every',
            everySeconds: Number.MAX_VALUE,
            anchorAt: NOW.toISOString(),
          },
          NOW,
        ),
      'invalid_schedule',
    )
    assertScheduleError(
      () =>
        computeNextRunAt(
          {
            kind: 'every',
            everySeconds: 300,
            anchorAt: NOW.toISOString(),
          },
          new Date(8.64e15),
        ),
      'invalid_schedule',
    )
  })

  test('returns the next cron point strictly after the cursor in its timezone', () => {
    const schedule: ScheduleSpec = {
      kind: 'cron',
      expression: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    }
    assert.equal(
      computeNextRunAt(schedule, new Date('2026-07-14T01:00:00.000Z'))?.toISOString(),
      '2026-07-15T01:00:00.000Z',
    )
  })
})
