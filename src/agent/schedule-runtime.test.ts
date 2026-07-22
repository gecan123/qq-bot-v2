import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { createScheduleRuntime, ScheduleRuntimeError } from './schedule-runtime.js'
import { createInMemoryScheduleStore, type ScheduleJob } from './schedule-store.js'
import { createInMemoryScheduleOccurrenceStore } from './schedule-occurrence-store.js'

describe('schedule runtime', () => {
  test('creates, fires and removes a one-shot schedule', async () => {
    let now = new Date('2026-07-13T00:00:00.000Z')
    const callbacks: Array<() => void> = []
    const queue = new InMemoryEventQueue<BotEvent>()
    const occurrences = createInMemoryScheduleOccurrenceStore()
    const runtime = createScheduleRuntime({
      store: createInMemoryScheduleStore(),
      occurrenceStore: occurrences,
      eventQueue: queue,
      now: () => now,
      createId: () => 'schedule-1',
      setTimer: (callback) => {
        callbacks.push(callback)
        return callback
      },
      clearTimer() {},
    })
    await runtime.start()
    const created = await runtime.create({
      name: '一次提醒',
      intention: '重新判断',
      afterSeconds: 60,
    })
    assert.equal(created.status, 'created')
    assert.equal((await runtime.list()).length, 1)

    now = new Date('2026-07-13T00:01:00.000Z')
    callbacks.at(-1)!()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(await runtime.list(), [])
    assert.deepEqual(await runtime.getOccurrence('schedule-1'), {
      scheduleId: 'schedule-1',
      name: '一次提醒',
      intention: '重新判断',
      scheduledFor: '2026-07-13T00:01:00.000Z',
    })
    assert.deepEqual(queue.dequeue(), {
      type: 'scheduled_wake',
      scheduleId: 'schedule-1',
      name: '一次提醒',
      scheduledFor: now,
    })
  })

  test('restores an overdue one-shot without recurrence merging', async () => {
    const job: ScheduleJob = {
      id: 'overdue',
      name: '过期提醒',
      intention: '只触发这一次',
      createdAt: '2026-07-13T00:00:00.000Z',
      at: '2026-07-13T00:01:00.000Z',
    }
    const callbacks: Array<() => void> = []
    const queue = new InMemoryEventQueue<BotEvent>()
    const runtime = createScheduleRuntime({
      store: createInMemoryScheduleStore([job]),
      eventQueue: queue,
      now: () => new Date('2026-07-13T01:00:00.000Z'),
      setTimer: (callback) => {
        callbacks.push(callback)
        return callback
      },
      clearTimer() {},
    })
    await runtime.start()
    assert.equal(callbacks.length, 1)
    callbacks[0]!()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(queue.size(), 1)
    assert.deepEqual(await runtime.list(), [])
  })

  test('rejects recurrence-shaped create input', async () => {
    const runtime = createScheduleRuntime({
      store: createInMemoryScheduleStore(),
      eventQueue: new InMemoryEventQueue<BotEvent>(),
    })
    await runtime.start()
    await assert.rejects(
      runtime.create({
        name: '周期',
        intention: '不再支持',
        everySeconds: 300,
      } as never),
      (error) => error instanceof ScheduleRuntimeError && error.code === 'invalid_schedule',
    )
  })
})
