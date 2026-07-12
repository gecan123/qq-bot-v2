import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { DurableWakeScheduler } from '../durable-wake-scheduler.js'
import { createScheduleTool } from './schedule.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'

const ctx = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }

describe('schedule tool', () => {
  test('creates, lists, and cancels durable wake schedules', async () => {
    let active = true
    const scheduler: DurableWakeScheduler = {
      schedule(input) {
        return {
          id: 'schedule-1',
          reason: input.reason,
          startedAt: new Date('2026-07-12T00:00:00.000Z'),
          dueAt: new Date('2026-07-12T00:01:00.000Z'),
        }
      },
      list() {
        return active ? [{
          id: 'schedule-1',
          reason: '检查任务',
          startedAt: new Date('2026-07-12T00:00:00.000Z'),
          dueAt: new Date('2026-07-12T00:01:00.000Z'),
        }] : []
      },
      cancel(id) {
        if (id !== 'schedule-1' || !active) return false
        active = false
        return true
      },
      stop() {},
    }
    const tool = createScheduleTool(scheduler)

    const created = JSON.parse(String((await tool.execute({
      action: 'create', delaySeconds: 60, reason: '检查任务',
    }, ctx)).content))
    assert.equal(created.scheduleId, 'schedule-1')
    assert.equal(created.dueAt, '2026-07-12T08:01:00.000+08:00')

    const listed = JSON.parse(String((await tool.execute({ action: 'list' }, ctx)).content))
    assert.equal(listed.schedules.length, 1)

    const cancelled = JSON.parse(String((await tool.execute({
      action: 'cancel', scheduleId: 'schedule-1',
    }, ctx)).content))
    assert.equal(cancelled.ok, true)
  })
})
