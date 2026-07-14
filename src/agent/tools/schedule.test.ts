import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type {
  CreateScheduleInput,
  CreateScheduleResult,
  ScheduleRuntime,
} from '../schedule-runtime.js'
import { ScheduleRuntimeError } from '../schedule-runtime.js'
import type { ScheduleJob } from '../schedule-store.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import { createScheduleTool } from './schedule.js'

const ctx = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }

function scheduleJob(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: 'schedule-1',
    name: '检查任务',
    intention: '结合最新进展检查任务是否需要继续推进',
    schedule: { kind: 'at', at: '2026-07-13T01:00:00.000Z' },
    createdAt: '2026-07-13T00:00:00.000Z',
    expiresAt: '2026-07-16T00:00:00.000Z',
    nextRunAt: '2026-07-13T01:00:00.000Z',
    runCount: 0,
    ...overrides,
  }
}

function runtimeStub(overrides: Partial<ScheduleRuntime> = {}): ScheduleRuntime {
  return {
    async start() {},
    async create() {
      throw new Error('unexpected create')
    },
    async list() {
      return []
    },
    async cancel(id) {
      return { status: 'already_absent', id }
    },
    async stop() {},
    ...overrides,
  }
}

function parseContent(content: unknown): Record<string, unknown> {
  return JSON.parse(String(content)) as Record<string, unknown>
}

describe('schedule tool', () => {
  test('delegates every create schedule variant to the runtime unchanged', async () => {
    const cases: Array<{
      label: string
      input: CreateScheduleInput
      storedSchedule: ScheduleJob['schedule']
    }> = [
      {
        label: 'absolute at',
        input: {
          name: '绝对时间',
          intention: '到点重新判断',
          schedule: { kind: 'at', at: '2026-07-13T12:00:00.000+08:00' },
        },
        storedSchedule: { kind: 'at', at: '2026-07-13T04:00:00.000Z' },
      },
      {
        label: 'relative at',
        input: {
          name: '相对时间',
          intention: '稍后重新判断',
          schedule: { kind: 'at', afterSeconds: 60 },
          maxRuns: 1,
        },
        storedSchedule: { kind: 'at', at: '2026-07-13T01:00:00.000Z' },
      },
      {
        label: 'every',
        input: {
          name: '周期检查',
          intention: '周期性重新判断',
          schedule: {
            kind: 'every',
            everySeconds: 600,
            anchorAt: '2026-07-13T08:00:00.000+08:00',
          },
          maxRuns: 3,
        },
        storedSchedule: {
          kind: 'every',
          everySeconds: 600,
          anchorAt: '2026-07-13T00:00:00.000Z',
        },
      },
      {
        label: 'cron',
        input: {
          name: 'cron 检查',
          intention: '按 cron 重新判断',
          schedule: { kind: 'cron', expression: '*/15 * * * *', timezone: 'Asia/Tokyo' },
        },
        storedSchedule: {
          kind: 'cron',
          expression: '*/15 * * * *',
          timezone: 'Asia/Tokyo',
        },
      },
    ]

    for (const item of cases) {
      let received: CreateScheduleInput | undefined
      const runtime = runtimeStub({
        async create(input) {
          received = input
          return {
            status: 'created',
            schedule: scheduleJob({
              id: item.label,
              name: item.input.name,
              intention: item.input.intention,
              schedule: item.storedSchedule,
              ...(item.input.maxRuns === undefined ? {} : { maxRuns: item.input.maxRuns }),
            }),
          }
        },
      })
      const tool = createScheduleTool(runtime)
      const args = tool.schema.parse({ action: 'create', ...item.input }) as Parameters<
        typeof tool.execute
      >[0]

      const result = await tool.execute(args, ctx)

      assert.deepEqual(received, item.input, item.label)
      assert.equal(result.outcome?.ok, true)
      assert.equal(result.outcome?.code, 'created')
      const content = parseContent(result.content)
      assert.equal(content.ok, true)
      assert.equal(content.status, 'created')
    }
  })

  test('returns created and existing schedules as bounded Beijing-time views', async () => {
    for (const status of ['created', 'existing'] as const) {
      const resultValue: CreateScheduleResult = {
        status,
        schedule: scheduleJob({
          schedule: {
            kind: 'every',
            everySeconds: 600,
            anchorAt: '2026-07-13T00:00:00.000Z',
          },
          lastRunAt: '2026-07-13T00:30:00.000Z',
          runCount: 1,
          maxRuns: 4,
        }),
      }
      const tool = createScheduleTool(runtimeStub({ async create() { return resultValue } }))

      const result = await tool.execute({
        action: 'create',
        name: '检查任务',
        intention: '结合最新进展检查任务是否需要继续推进',
        schedule: { kind: 'every', everySeconds: 600 },
      }, ctx)

      assert.deepEqual(parseContent(result.content), {
        ok: true,
        status,
        schedule: {
          id: 'schedule-1',
          name: '检查任务',
          intention: '结合最新进展检查任务是否需要继续推进',
          schedule: {
            kind: 'every',
            everySeconds: 600,
            anchorAt: '2026-07-13T08:00:00.000+08:00',
          },
          createdAt: '2026-07-13T08:00:00.000+08:00',
          expiresAt: '2026-07-16T08:00:00.000+08:00',
          nextRunAt: '2026-07-13T09:00:00.000+08:00',
          lastRunAt: '2026-07-13T08:30:00.000+08:00',
          runCount: 1,
          maxRuns: 4,
        },
      })
      assert.deepEqual(result.outcome, { ok: true, code: status })
    }
  })

  test('lists only stable public fields in runtime order', async () => {
    const first = scheduleJob({
      id: 'first',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'Asia/Shanghai' },
    }) as ScheduleJob & { timerHandle: number }
    first.timerHandle = 123
    const second = scheduleJob({
      id: 'second',
      schedule: { kind: 'at', at: '2026-07-13T02:00:00.000Z' },
      nextRunAt: '2026-07-13T02:00:00.000Z',
    })
    const tool = createScheduleTool(runtimeStub({ async list() { return [first, second] } }))

    const result = await tool.execute({ action: 'list' }, ctx)

    const content = parseContent(result.content) as { schedules: Array<Record<string, unknown>> }
    assert.deepEqual(content.schedules.map((schedule) => schedule.id), ['first', 'second'])
    assert.equal('timerHandle' in content.schedules[0]!, false)
    assert.deepEqual(Object.keys(content.schedules[0]!), [
      'id',
      'name',
      'intention',
      'schedule',
      'createdAt',
      'expiresAt',
      'nextRunAt',
      'runCount',
    ])
  })

  test('treats cancelled and already-absent cancellation as idempotent success', async () => {
    for (const status of ['cancelled', 'already_absent'] as const) {
      let receivedId: string | undefined
      const tool = createScheduleTool(runtimeStub({
        async cancel(id) {
          receivedId = id
          return { status, id }
        },
      }))

      const result = await tool.execute({ action: 'cancel', id: 'schedule-1' }, ctx)

      assert.equal(receivedId, 'schedule-1')
      assert.deepEqual(parseContent(result.content), {
        ok: true,
        status,
        id: 'schedule-1',
      })
      assert.deepEqual(result.outcome, { ok: true, code: status })
    }
  })

  test('schema rejects invalid names, intentions, schedules, and run limits', () => {
    const tool = createScheduleTool(runtimeStub())
    const valid = {
      action: 'create',
      name: '检查任务',
      intention: '届时结合最新状态重新判断',
      schedule: { kind: 'at', afterSeconds: 30 },
    }
    const invalidInputs: unknown[] = [
      { ...valid, name: '' },
      { ...valid, name: 'x'.repeat(101) },
      { ...valid, intention: '' },
      { ...valid, intention: 'x'.repeat(1001) },
      { ...valid, schedule: { kind: 'at' } },
      { ...valid, schedule: { kind: 'at', at: '2026-07-13T00:00:00Z', afterSeconds: 60 } },
      { ...valid, schedule: { kind: 'at', afterSeconds: 29 } },
      { ...valid, schedule: { kind: 'at', afterSeconds: 259_201 } },
      { ...valid, schedule: { kind: 'every', everySeconds: 299 } },
      { ...valid, schedule: { kind: 'cron', expression: '' } },
      { ...valid, schedule: { kind: 'cron', expression: 'x'.repeat(201) } },
      { ...valid, schedule: { kind: 'cron', expression: '* * * * *', timezone: '' } },
      { ...valid, schedule: { kind: 'cron', expression: '* * * * *', timezone: 'x'.repeat(101) } },
      { ...valid, maxRuns: 0 },
      { ...valid, maxRuns: 1.5 },
      { action: 'list', extra: true },
      { action: 'cancel', id: '' },
    ]

    for (const input of invalidInputs) {
      assert.equal(tool.schema.safeParse(input).success, false, JSON.stringify(input))
    }
    assert.equal(tool.schema.safeParse({
      ...valid,
      schedule: { kind: 'every', everySeconds: 259_201 },
    }).success, true)
  })

  test('turns runtime domain errors into stable actionable results', async () => {
    const cases = [
      { code: 'name_conflict', scheduleId: 'existing-1' },
      { code: 'active_limit_reached' },
      { code: 'invalid_input' },
      { code: 'invalid_schedule' },
      { code: 'recurrence_too_frequent' },
      { code: 'outside_schedule_window' },
      { code: 'persistence_failed' },
      { code: 'stopped' },
    ] as const

    for (const item of cases) {
      const tool = createScheduleTool(runtimeStub({
        async create() {
          throw new ScheduleRuntimeError(item.code, 'internal detail must not leak', {
            ...('scheduleId' in item ? { scheduleId: item.scheduleId } : {}),
          })
        },
      }))

      const result = await tool.execute({
        action: 'create',
        name: '检查任务',
        intention: '届时重新判断',
        schedule: { kind: 'at', afterSeconds: 60 },
      }, ctx)

      const content = parseContent(result.content)
      assert.equal(content.ok, false, item.code)
      assert.equal(content.status, item.code, item.code)
      assert.equal(String(content.error).includes('internal detail'), false, item.code)
      assert.deepEqual(result.outcome, { ok: false, code: item.code })
      if (item.code === 'name_conflict') {
        assert.equal(content.scheduleId, 'existing-1')
        assert.match(String(content.error), /cancel/)
      }
    }
  })

  test('does not swallow unknown runtime failures', async () => {
    const failure = new Error('programmer bug')
    const tool = createScheduleTool(runtimeStub({ async list() { throw failure } }))

    await assert.rejects(() => tool.execute({ action: 'list' }, ctx), failure)
  })

  test('describes schedules as future attention rather than stored commands', () => {
    const description = createScheduleTool(runtimeStub()).description

    assert.match(description, /最长 3 天/)
    assert.match(description, /scheduled_wake/)
    assert.match(description, /重新判断/)
    assert.match(description, /不.*未来工具调用/)
    assert.match(description, /Asia\/Shanghai/)
    assert.match(description, /至少 5 分钟/)
    assert.match(description, /20/)
    assert.match(description, /pause/)
  })
})
