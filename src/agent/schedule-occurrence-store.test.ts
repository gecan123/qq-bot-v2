import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  createInMemoryScheduleOccurrenceStore,
  createPersistentScheduleOccurrenceStore,
  type ScheduleOccurrence,
} from './schedule-occurrence-store.js'

const occurrence: ScheduleOccurrence = {
  scheduleId: 'schedule-1',
  name: '检查进展',
  intention: '结合最新上下文判断是否继续',
  scheduleKind: 'at',
  scheduledFor: '2026-07-22T01:00:00.000Z',
  runCount: 1,
}

describe('schedule occurrence store', () => {
  test('records an occurrence idempotently and rejects conflicting bodies', async () => {
    const store = createInMemoryScheduleOccurrenceStore()
    await store.record(occurrence)
    await store.record(occurrence)
    assert.deepEqual(await store.get('schedule-1', 1), occurrence)
    await assert.rejects(
      store.record({ ...occurrence, intention: 'different' }),
      /occurrence conflict/,
    )
  })

  test('persists occurrence bodies for later on-demand reads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qq-bot-schedule-occurrence-'))
    const path = join(directory, 'occurrences.json')
    try {
      await createPersistentScheduleOccurrenceStore(path).record(occurrence)
      const reloaded = createPersistentScheduleOccurrenceStore(path)
      assert.deepEqual(await reloaded.get('schedule-1', 1), occurrence)
      assert.match(readFileSync(path, 'utf8'), /结合最新上下文判断是否继续/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
