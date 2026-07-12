import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  compareTimestampsDesc,
  formatBeijingCompact,
  formatBeijingDateTime,
  formatBeijingIso,
  formatBeijingMonth,
} from './beijing-time.js'

describe('Beijing time formatting', () => {
  const instant = new Date('2026-07-12T02:23:34.056Z')

  test('renders an explicit +08:00 offset', () => {
    assert.equal(formatBeijingIso(instant), '2026-07-12T10:23:34.056+08:00')
    assert.equal(new Date(formatBeijingIso(instant)).getTime(), instant.getTime())
  })

  test('renders stable human, month, and compact forms', () => {
    assert.equal(formatBeijingDateTime(instant), '2026-07-12 10:23:34')
    assert.equal(formatBeijingMonth(instant), '2026-07')
    assert.equal(formatBeijingCompact(instant), '20260712102334056')
  })

  test('uses the Beijing calendar date across a UTC day boundary', () => {
    const boundary = new Date('2026-01-31T16:30:00.000Z')
    assert.equal(formatBeijingIso(boundary), '2026-02-01T00:30:00.000+08:00')
    assert.equal(formatBeijingMonth(boundary), '2026-02')
  })

  test('orders legacy UTC and Beijing timestamps by their absolute instant', () => {
    const values = ['2026-07-12T02:00:00.000Z', '2026-07-12T11:00:00.000+08:00']
    assert.deepEqual(values.sort(compareTimestampsDesc), [
      '2026-07-12T11:00:00.000+08:00',
      '2026-07-12T02:00:00.000Z',
    ])
  })
})
