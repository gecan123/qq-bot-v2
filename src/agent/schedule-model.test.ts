import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { normalizeScheduleAt, ScheduleModelError } from './schedule-model.js'

const NOW = new Date('2026-07-13T00:00:00.000Z')

describe('schedule model', () => {
  test('normalizes absolute and relative one-shot times', () => {
    assert.equal(
      normalizeScheduleAt({ at: '2026-07-13T08:01:00+08:00' }, NOW),
      '2026-07-13T00:01:00.000Z',
    )
    assert.equal(
      normalizeScheduleAt({ afterSeconds: 90 }, NOW),
      '2026-07-13T00:01:30.000Z',
    )
  })

  test('rejects times outside 30 seconds to three days', () => {
    for (const input of [{ afterSeconds: 29 }, { afterSeconds: 259_201 }]) {
      assert.throws(
        () => normalizeScheduleAt(input, NOW),
        (error) => error instanceof ScheduleModelError && error.code === 'outside_schedule_window',
      )
    }
  })

  test('rejects recurrence and ambiguous inputs', () => {
    for (const input of [
      { everySeconds: 300 },
      { expression: '0 9 * * *' },
      { at: '2026-07-13T00:01:00Z', afterSeconds: 60 },
    ]) {
      assert.throws(
        () => normalizeScheduleAt(input, NOW),
        (error) => error instanceof ScheduleModelError && error.code === 'invalid_schedule',
      )
    }
  })
})
