import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  createInMemoryScheduleStore,
  createPersistentScheduleStore,
  type ScheduleJob,
} from './schedule-store.js'

const job: ScheduleJob = {
  id: 'schedule-1',
  name: '一次提醒',
  intention: '到点结合最新上下文判断',
  createdAt: '2026-07-13T00:00:00.000Z',
  at: '2026-07-13T00:01:00.000Z',
}

describe('schedule store', () => {
  test('round-trips only the one-shot job shape', async () => {
    const store = createInMemoryScheduleStore([job])
    assert.deepEqual(await store.load(), [job])
    await assert.rejects(store.replace([{ ...job, at: job.createdAt }]))
  })

  test('persists schema version 2 atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-store-'))
    try {
      const path = join(root, 'schedules.json')
      const store = createPersistentScheduleStore(path)
      await store.replace([job])
      assert.deepEqual(await store.load(), [job])
      assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
