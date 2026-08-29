import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  beijingDateStart,
  compareTimestampsDesc,
  formatBeijingCompact,
  formatBeijingDate,
  formatBeijingDateTime,
  formatBeijingIso,
  formatBeijingMinuteIso,
  formatBeijingMonth,
  shiftBeijingDate,
} from './beijing-time.js'

describe('Beijing time formatting', () => {
  const instant = new Date('2026-07-12T02:23:34.056Z')

  test('renders an explicit +08:00 offset', () => {
    assert.equal(formatBeijingIso(instant), '2026-07-12T10:23:34.056+08:00')
    assert.equal(new Date(formatBeijingIso(instant)).getTime(), instant.getTime())
  })

  test('renders a minute-level wall-clock baseline', () => {
    assert.equal(formatBeijingMinuteIso(instant), '2026-07-12T10:23+08:00')
  })

  test('renders stable human, month, and compact forms', () => {
    assert.equal(formatBeijingDateTime(instant), '2026-07-12 10:23:34')
    assert.equal(formatBeijingMonth(instant), '2026-07')
    assert.equal(formatBeijingCompact(instant), '20260712102334056')
  })

  test('uses the Beijing calendar date across a UTC day boundary', () => {
    const boundary = new Date('2026-01-31T16:30:00.000Z')
    assert.equal(formatBeijingIso(boundary), '2026-02-01T00:30:00.000+08:00')
    assert.equal(formatBeijingDate(boundary), '2026-02-01')
    assert.equal(formatBeijingMonth(boundary), '2026-02')
  })

  test('creates and shifts Beijing calendar-day boundaries', () => {
    assert.equal(beijingDateStart('2026-08-23').toISOString(), '2026-08-22T16:00:00.000Z')
    assert.equal(shiftBeijingDate('2026-08-23', -6), '2026-08-17')
    assert.equal(shiftBeijingDate('2026-02-28', 1), '2026-03-01')
    assert.throws(() => beijingDateStart('2026-02-30'), /invalid Beijing date/)
  })

  test('orders legacy UTC and Beijing timestamps by their absolute instant', () => {
    const values = ['2026-07-12T02:00:00.000Z', '2026-07-12T11:00:00.000+08:00']
    assert.deepEqual(values.sort(compareTimestampsDesc), [
      '2026-07-12T11:00:00.000+08:00',
      '2026-07-12T02:00:00.000Z',
    ])
  })
})
