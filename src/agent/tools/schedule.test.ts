import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ScheduleRuntime } from '../schedule-runtime.js'
import { createScheduleTool } from './schedule.js'

const ctx = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }

describe('schedule tool', () => {
  test('exposes only at and afterSeconds create variants', () => {
    const schema = createScheduleTool(stubRuntime()).schema
    assert.equal(schema.safeParse({
      action: 'create', name: '绝对时间', intention: '重新判断', at: '2026-07-13T00:01:00Z',
    }).success, true)
    assert.equal(schema.safeParse({
      action: 'create', name: '相对时间', intention: '重新判断', afterSeconds: 60,
    }).success, true)
    assert.equal(schema.safeParse({
      action: 'create', name: '周期', intention: '不支持', everySeconds: 300,
    }).success, false)
    assert.equal(schema.safeParse({
      action: 'create', name: 'cron', intention: '不支持', expression: '0 9 * * *',
    }).success, false)
  })

  test('get_occurrence needs only scheduleId', async () => {
    const tool = createScheduleTool(stubRuntime({
      async getOccurrence(scheduleId) {
        assert.equal(scheduleId, 'schedule-1')
        return {
          scheduleId,
          name: '一次提醒',
          intention: '重新判断',
          scheduledFor: '2026-07-13T00:01:00.000Z',
        }
      },
    }))
    const result = await tool.execute({ action: 'get_occurrence', scheduleId: 'schedule-1' }, ctx)
    assert.equal(JSON.parse(result.content as string).ok, true)
  })
})

function stubRuntime(overrides: Partial<ScheduleRuntime> = {}): ScheduleRuntime {
  return {
    async start() {},
    async create() { throw new Error('unexpected') },
    async list() { return [] },
    async getOccurrence() { return null },
    async cancel(id) { return { status: 'already_absent', id } },
    async stop() {},
    ...overrides,
  }
}
