import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createInMemoryScheduleOccurrenceStore } from './schedule-occurrence-store.js'

const occurrence = {
  scheduleId: 'schedule-1',
  name: '一次提醒',
  intention: '重新判断',
  scheduledFor: '2026-07-13T00:01:00.000Z',
}

describe('schedule occurrence store', () => {
  test('stores one occurrence per schedule idempotently', async () => {
    const store = createInMemoryScheduleOccurrenceStore()
    await store.record(occurrence)
    await store.record(occurrence)
    assert.deepEqual(await store.get('schedule-1'), occurrence)
    await assert.rejects(store.record({ ...occurrence, intention: '冲突内容' }))
  })
})
