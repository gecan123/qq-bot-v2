import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { SCHEDULE_LIMITS } from './schedule-model.js'
import {
  createInMemoryScheduleStore,
  type ScheduleJob,
  type ScheduleStore,
} from './schedule-store.js'
import {
  createScheduleRuntime,
  ScheduleRuntimeError,
  type ScheduleRuntime,
} from './schedule-runtime.js'

type TimerCallback = () => void

class FakeClock {
  private nextHandle = 1
  private readonly callbacks = new Map<number, { callback: TimerCallback; dueAt: number }>()
  current: Date

  constructor(now = '2026-07-14T01:00:00.000Z') {
    this.current = new Date(now)
  }

  readonly now = (): Date => new Date(this.current)

  readonly setTimer = (callback: TimerCallback, delayMs: number): number => {
    const handle = this.nextHandle++
    this.callbacks.set(handle, {
      callback,
      dueAt: this.current.getTime() + delayMs,
    })
    return handle
  }

  readonly clearTimer = (handle: unknown): void => {
    this.callbacks.delete(handle as number)
  }

  setNow(value: string): void {
    this.current = new Date(value)
  }

  timerCount(): number {
    return this.callbacks.size
  }

  nextDelayMs(): number | null {
    const dueAt = [...this.callbacks.values()]
      .map((timer) => timer.dueAt)
      .sort((left, right) => left - right)[0]
    return dueAt === undefined ? null : dueAt - this.current.getTime()
  }

  firstHandle(): number {
    const first = [...this.callbacks.entries()].sort(
      ([leftHandle, left], [rightHandle, right]) =>
        left.dueAt - right.dueAt || leftHandle - rightHandle,
    )[0]
    assert.ok(first, 'expected an armed timer')
    return first[0]
  }

  capture(handle = this.firstHandle()): TimerCallback {
    const timer = this.callbacks.get(handle)
    assert.ok(timer, `expected timer ${handle}`)
    return timer.callback
  }

  fire(handle = this.firstHandle()): void {
    const callback = this.capture(handle)
    this.callbacks.delete(handle)
    callback()
  }
}

class RecordingStore implements ScheduleStore {
  readonly replacements: ScheduleJob[][] = []
  failNextReplace: Error | null = null
  private readonly inner: ScheduleStore

  constructor(initial: readonly ScheduleJob[] = []) {
    this.inner = createInMemoryScheduleStore(initial)
  }

  async load(): Promise<ScheduleJob[]> {
    return this.inner.load()
  }

  async replace(schedules: readonly ScheduleJob[]): Promise<void> {
    if (this.failNextReplace) {
      const error = this.failNextReplace
      this.failNextReplace = null
      throw error
    }
    await this.inner.replace(schedules)
    this.replacements.push(structuredClone(schedules) as ScheduleJob[])
  }
}

function atJob(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: 'schedule-1',
    name: 'review-progress',
    intention: 'Review the latest goal and decide the next useful action',
    schedule: { kind: 'at', at: '2026-07-14T01:10:00.000Z' },
    createdAt: '2026-07-14T01:00:00.000Z',
    expiresAt: '2026-07-17T01:00:00.000Z',
    nextRunAt: '2026-07-14T01:10:00.000Z',
    runCount: 0,
    ...overrides,
  }
}

function everyJob(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return atJob({
    id: 'every-1',
    name: 'periodic-review',
    schedule: {
      kind: 'every',
      everySeconds: 600,
      anchorAt: '2026-07-14T01:00:00.000Z',
    },
    nextRunAt: '2026-07-14T01:10:00.000Z',
    ...overrides,
  })
}

function cronJob(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return atJob({
    id: 'cron-1',
    name: 'cron-review',
    schedule: {
      kind: 'cron',
      expression: '*/10 * * * *',
      timezone: 'UTC',
    },
    nextRunAt: '2026-07-14T01:10:00.000Z',
    ...overrides,
  })
}

function harness(options: {
  clock?: FakeClock
  store?: ScheduleStore
  eventQueue?: EventQueueForTest
  createId?: () => string
  logger?: (entry: { event: string; scheduleId: string; error: unknown }) => void
  retryDelayMs?: number
} = {}): {
  clock: FakeClock
  store: ScheduleStore
  eventQueue: EventQueueForTest
  runtime: ScheduleRuntime
} {
  const clock = options.clock ?? new FakeClock()
  const store = options.store ?? new RecordingStore()
  const eventQueue = options.eventQueue ?? new InMemoryEventQueue<BotEvent>()
  return {
    clock,
    store,
    eventQueue,
    runtime: createScheduleRuntime({
      store,
      eventQueue,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      createId: options.createId ?? (() => 'generated-id'),
      logger: options.logger,
      retryDelayMs: options.retryDelayMs,
    }),
  }
}

type EventQueueForTest = InMemoryEventQueue<BotEvent>

async function flushTimerMutation(runtime: ScheduleRuntime): Promise<void> {
  await Promise.resolve()
  await runtime.list()
}

async function expectRuntimeCode(
  action: Promise<unknown>,
  code: ScheduleRuntimeError['code'],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.equal(error instanceof ScheduleRuntimeError, true)
    assert.equal((error as ScheduleRuntimeError).code, code)
    return true
  })
}

describe('ScheduleRuntime lifecycle and CRUD', () => {
  test('requires start before CRUD and arms each future persisted job exactly once', async () => {
    const clock = new FakeClock()
    const { runtime } = harness({
      clock,
      store: new RecordingStore([
        atJob(),
        atJob({
          id: 'schedule-2',
          name: 'later-review',
          schedule: { kind: 'at', at: '2026-07-14T01:20:00.000Z' },
          nextRunAt: '2026-07-14T01:20:00.000Z',
        }),
      ]),
    })

    await expectRuntimeCode(runtime.list(), 'not_started')
    await runtime.start()

    assert.equal(clock.timerCount(), 2)
    assert.equal(clock.nextDelayMs(), 10 * 60_000)
    await expectRuntimeCode(runtime.start(), 'already_started')
  })

  test('does not enter the started state when loading fails', async () => {
    let attempts = 0
    const store: ScheduleStore = {
      async load() {
        attempts += 1
        if (attempts === 1) throw new Error('corrupt schedule file')
        return []
      },
      async replace() {},
    }
    const { runtime } = harness({ store })

    await assert.rejects(runtime.start(), /corrupt schedule file/)
    await expectRuntimeCode(runtime.list(), 'not_started')
    await runtime.start()
    assert.deepEqual(await runtime.list(), [])
  })

  test('persists a new schedule before publishing it or arming its timer', async () => {
    let releaseReplace: (() => void) | undefined
    let persisted: ScheduleJob[] = []
    const store: ScheduleStore = {
      async load() {
        return structuredClone(persisted) as ScheduleJob[]
      },
      async replace(schedules) {
        await new Promise<void>((resolve) => {
          releaseReplace = resolve
        })
        persisted = structuredClone(schedules) as ScheduleJob[]
      },
    }
    const { runtime, clock } = harness({ store })
    await runtime.start()

    const creating = runtime.create({
      name: 'checkpoint',
      intention: 'Re-evaluate the active goal',
      schedule: { kind: 'at', afterSeconds: 600 },
    })
    await Promise.resolve()

    assert.equal(clock.timerCount(), 0)
    releaseReplace?.()
    const result = await creating

    assert.equal(result.status, 'created')
    assert.equal(result.schedule.nextRunAt, '2026-07-14T01:10:00.000Z')
    assert.equal(result.schedule.expiresAt, '2026-07-17T01:00:00.000Z')
    assert.equal(clock.timerCount(), 1)
    assert.deepEqual(await runtime.list(), persisted)
  })

  test('keeps memory and timers unchanged when create persistence fails', async () => {
    const store = new RecordingStore()
    const { runtime, clock } = harness({ store })
    await runtime.start()
    store.failNextReplace = new Error('disk full')

    await assert.rejects(
      runtime.create({
        name: 'checkpoint',
        intention: 'Re-evaluate the active goal',
        schedule: { kind: 'at', afterSeconds: 600 },
      }),
      /disk full/,
    )

    assert.deepEqual(await runtime.list(), [])
    assert.deepEqual(await store.load(), [])
    assert.equal(clock.timerCount(), 0)
  })

  test('serializes concurrent mutations so replacements cannot lose schedules', async () => {
    let nextId = 1
    const store = new RecordingStore()
    const { runtime } = harness({ store, createId: () => `schedule-${nextId++}` })
    await runtime.start()

    await Promise.all([
      runtime.create({
        name: 'first',
        intention: 'Review the first thread',
        schedule: { kind: 'at', afterSeconds: 600 },
      }),
      runtime.create({
        name: 'second',
        intention: 'Review the second thread',
        schedule: { kind: 'at', afterSeconds: 900 },
      }),
    ])

    assert.deepEqual((await runtime.list()).map((job) => job.name), ['first', 'second'])
    assert.deepEqual(store.replacements.at(-1)?.map((job) => job.name), ['first', 'second'])
  })

  test('rejects invalid fields without mutating persistent state', async () => {
    const store = new RecordingStore()
    const { runtime, clock } = harness({ store })
    await runtime.start()

    await expectRuntimeCode(
      runtime.create({ name: ' ', intention: 'valid', schedule: { kind: 'at', afterSeconds: 600 } }),
      'invalid_input',
    )
    await expectRuntimeCode(
      runtime.create({ name: 'valid', intention: '', schedule: { kind: 'at', afterSeconds: 600 } }),
      'invalid_input',
    )
    await expectRuntimeCode(
      runtime.create({
        name: 'valid',
        intention: 'valid',
        schedule: { kind: 'at', afterSeconds: 600 },
        maxRuns: 0,
      }),
      'invalid_input',
    )

    assert.equal(store.replacements.length, 0)
    assert.equal(clock.timerCount(), 0)
  })

  test('treats a later retry of the same relative at definition as idempotent', async () => {
    const { runtime, clock } = harness()
    await runtime.start()
    const input = {
      name: 'checkpoint',
      intention: 'Re-evaluate the active goal',
      schedule: { kind: 'at' as const, afterSeconds: 600 },
      maxRuns: 1,
    }

    const first = await runtime.create(input)
    clock.setNow('2026-07-14T01:02:00.000Z')
    const second = await runtime.create(input)

    assert.equal(first.status, 'created')
    assert.equal(second.status, 'existing')
    assert.deepEqual(second.schedule, first.schedule)
    assert.equal(clock.timerCount(), 1)
  })

  test('rejects a changed definition that reuses an active name', async () => {
    const { runtime } = harness()
    await runtime.start()
    await runtime.create({
      name: 'checkpoint',
      intention: 'Review goal A',
      schedule: { kind: 'at', afterSeconds: 600 },
    })

    await expectRuntimeCode(
      runtime.create({
        name: 'checkpoint',
        intention: 'Review goal B',
        schedule: { kind: 'at', afterSeconds: 600 },
      }),
      'name_conflict',
    )
  })

  test('enforces the active schedule limit', async () => {
    let nextId = 0
    const { runtime } = harness({ createId: () => `schedule-${nextId++}` })
    await runtime.start()
    for (let index = 0; index < SCHEDULE_LIMITS.maxActiveSchedules; index += 1) {
      await runtime.create({
        name: `checkpoint-${index}`,
        intention: `Review goal ${index}`,
        schedule: { kind: 'at', afterSeconds: 600 + index },
      })
    }

    await expectRuntimeCode(
      runtime.create({
        name: 'one-too-many',
        intention: 'Must be rejected',
        schedule: { kind: 'at', afterSeconds: 900 },
      }),
      'active_limit_reached',
    )
  })

  test('returns deep-cloned schedules in stable next-run order', async () => {
    const { runtime } = harness({
      store: new RecordingStore([
        atJob({ id: 'b', name: 'b', createdAt: '2026-07-14T01:00:00.000Z' }),
        atJob({
          id: 'later',
          name: 'later',
          createdAt: '2026-07-14T01:00:00.000Z',
          schedule: { kind: 'at', at: '2026-07-14T01:20:00.000Z' },
          nextRunAt: '2026-07-14T01:20:00.000Z',
        }),
        atJob({ id: 'a', name: 'a', createdAt: '2026-07-14T01:00:00.000Z' }),
      ]),
    })
    await runtime.start()

    const listed = await runtime.list()
    assert.deepEqual(listed.map((schedule) => schedule.id), ['a', 'b', 'later'])
    listed[0]!.name = 'mutated by caller'
    assert.equal((await runtime.list())[0]!.name, 'a')
  })

  test('cancels persistently, is idempotent, and preserves state when persistence fails', async () => {
    const store = new RecordingStore([atJob()])
    const { runtime, clock } = harness({ store })
    await runtime.start()
    store.failNextReplace = new Error('disk full')

    await assert.rejects(runtime.cancel('schedule-1'), /disk full/)
    assert.equal(clock.timerCount(), 1)
    assert.deepEqual((await runtime.list()).map((schedule) => schedule.id), ['schedule-1'])

    assert.deepEqual(await runtime.cancel('schedule-1'), {
      status: 'cancelled',
      id: 'schedule-1',
    })
    assert.equal(clock.timerCount(), 0)
    assert.deepEqual(await runtime.cancel('schedule-1'), {
      status: 'already_absent',
      id: 'schedule-1',
    })
  })

  test('stops idempotently without deleting persisted jobs and rejects later CRUD', async () => {
    const store = new RecordingStore([atJob()])
    const { runtime, clock } = harness({ store })
    await runtime.start()

    await runtime.stop()
    await runtime.stop()

    assert.equal(clock.timerCount(), 0)
    assert.deepEqual(await store.load(), [atJob()])
    await expectRuntimeCode(runtime.list(), 'stopped')
  })

  test('cannot be started after stop is requested before initial startup', async () => {
    const { runtime } = harness()

    const stopping = runtime.stop()
    await expectRuntimeCode(runtime.start(), 'stopped')
    await stopping
    await expectRuntimeCode(runtime.list(), 'stopped')
  })
})

describe('ScheduleRuntime firing and restart recovery', () => {
  test('removes an expired job during start without waking or arming it', async () => {
    const clock = new FakeClock('2026-07-17T01:00:00.001Z')
    const store = new RecordingStore([atJob()])
    const { runtime, eventQueue } = harness({ clock, store })

    await runtime.start()

    assert.deepEqual(await runtime.list(), [])
    assert.deepEqual(await store.load(), [])
    assert.equal(eventQueue.size(), 0)
    assert.equal(clock.timerCount(), 0)
  })

  test('fires an overdue at job once during restart only after persisting its removal', async () => {
    const clock = new FakeClock('2026-07-14T01:20:00.000Z')
    let releaseReplace: (() => void) | undefined
    let markReplaceStarted: (() => void) | undefined
    const replaceStarted = new Promise<void>((resolve) => {
      markReplaceStarted = resolve
    })
    let persisted = [atJob()]
    const store: ScheduleStore = {
      async load() {
        return structuredClone(persisted) as ScheduleJob[]
      },
      async replace(schedules) {
        markReplaceStarted?.()
        await new Promise<void>((resolve) => {
          releaseReplace = resolve
        })
        persisted = structuredClone(schedules) as ScheduleJob[]
      },
    }
    const { runtime, eventQueue } = harness({ clock, store })

    const starting = runtime.start()
    await replaceStarted
    assert.equal(eventQueue.size(), 0)
    assert.equal(clock.timerCount(), 0)
    releaseReplace?.()
    await starting

    assert.deepEqual(persisted, [])
    assert.equal(eventQueue.size(), 1)
    assert.deepEqual(eventQueue.dequeue(), {
      type: 'scheduled_wake',
      scheduleId: 'schedule-1',
      name: 'review-progress',
      scheduleKind: 'at',
      scheduledFor: new Date('2026-07-14T01:10:00.000Z'),
      intention: 'Review the latest goal and decide the next useful action',
      runCount: 1,
    })
  })

  test('leaves start retryable and publishes nothing when recovery persistence fails', async () => {
    const clock = new FakeClock('2026-07-14T01:20:00.000Z')
    const store = new RecordingStore([atJob()])
    store.failNextReplace = new Error('disk unavailable')
    const { runtime, eventQueue } = harness({ clock, store })

    await assert.rejects(runtime.start(), /disk unavailable/)
    assert.equal(eventQueue.size(), 0)
    assert.equal(clock.timerCount(), 0)
    await expectRuntimeCode(runtime.list(), 'not_started')

    await runtime.start()
    assert.equal(eventQueue.size(), 1)
    assert.deepEqual(await runtime.list(), [])
  })

  test('coalesces missed every occurrences without drifting their anchor', async () => {
    const clock = new FakeClock('2026-07-14T01:36:00.000Z')
    const store = new RecordingStore([everyJob()])
    const { runtime, eventQueue } = harness({ clock, store })

    await runtime.start()

    assert.deepEqual(eventQueue.dequeue(), {
      type: 'scheduled_wake',
      scheduleId: 'every-1',
      name: 'periodic-review',
      scheduleKind: 'every',
      scheduledFor: new Date('2026-07-14T01:30:00.000Z'),
      intention: 'Review the latest goal and decide the next useful action',
      runCount: 1,
    })
    assert.deepEqual(await runtime.list(), [
      everyJob({
        lastRunAt: '2026-07-14T01:30:00.000Z',
        nextRunAt: '2026-07-14T01:40:00.000Z',
        runCount: 1,
      }),
    ])
    assert.equal(clock.nextDelayMs(), 4 * 60_000)
  })

  test('coalesces missed cron occurrences and arms the next real occurrence', async () => {
    const clock = new FakeClock('2026-07-14T01:25:00.000Z')
    const { runtime, eventQueue } = harness({
      clock,
      store: new RecordingStore([cronJob()]),
    })

    await runtime.start()

    const event = eventQueue.dequeue()
    assert.equal(event?.type, 'scheduled_wake')
    assert.equal(event?.scheduledFor.getTime(), Date.parse('2026-07-14T01:20:00.000Z'))
    assert.deepEqual(await runtime.list(), [
      cronJob({
        lastRunAt: '2026-07-14T01:20:00.000Z',
        nextRunAt: '2026-07-14T01:30:00.000Z',
        runCount: 1,
      }),
    ])
    assert.equal(clock.nextDelayMs(), 5 * 60_000)
  })

  test('allows a recurring occurrence exactly at expiry and removes it after firing', async () => {
    const boundaryJob = everyJob({
      schedule: {
        kind: 'every',
        everySeconds: 24 * 60 * 60,
        anchorAt: '2026-07-14T01:00:00.000Z',
      },
      nextRunAt: '2026-07-17T01:00:00.000Z',
      lastRunAt: '2026-07-16T01:00:00.000Z',
      runCount: 2,
    })
    const clock = new FakeClock(boundaryJob.expiresAt)
    const store = new RecordingStore([boundaryJob])
    const { runtime, eventQueue } = harness({ clock, store })

    await runtime.start()

    const event = eventQueue.dequeue()
    assert.equal(event?.type, 'scheduled_wake')
    assert.equal(event?.scheduledFor.getTime(), Date.parse(boundaryJob.expiresAt))
    assert.equal(event?.runCount, 3)
    assert.deepEqual(await runtime.list(), [])
    assert.equal(clock.timerCount(), 0)
  })

  test('allows an armed at boundary tick to fire when its callback is a few milliseconds late', async () => {
    const boundaryJob = atJob({
      schedule: { kind: 'at', at: '2026-07-17T01:00:00.000Z' },
      nextRunAt: '2026-07-17T01:00:00.000Z',
    })
    const clock = new FakeClock()
    const store = new RecordingStore([boundaryJob])
    const { runtime, eventQueue } = harness({ clock, store })
    await runtime.start()
    clock.setNow('2026-07-17T01:00:00.005Z')

    clock.fire()
    await flushTimerMutation(runtime)

    assert.deepEqual(await store.load(), [])
    assert.deepEqual(await runtime.list(), [])
    assert.deepEqual(eventQueue.dequeue(), {
      type: 'scheduled_wake',
      scheduleId: 'schedule-1',
      name: 'review-progress',
      scheduleKind: 'at',
      scheduledFor: new Date('2026-07-17T01:00:00.000Z'),
      intention: 'Review the latest goal and decide the next useful action',
      runCount: 1,
    })
    assert.equal(eventQueue.size(), 0)
  })

  test('retries an armed at boundary tick after persistence recovers past expiry', async () => {
    const boundaryJob = atJob({
      schedule: { kind: 'at', at: '2026-07-17T01:00:00.000Z' },
      nextRunAt: '2026-07-17T01:00:00.000Z',
    })
    const clock = new FakeClock()
    const store = new RecordingStore([boundaryJob])
    const { runtime, eventQueue } = harness({ clock, store, retryDelayMs: 1_000 })
    await runtime.start()
    store.failNextReplace = new Error('temporary write failure')
    clock.setNow(boundaryJob.expiresAt)

    clock.fire()
    await flushTimerMutation(runtime)
    assert.equal(eventQueue.size(), 0)
    assert.deepEqual(await runtime.list(), [boundaryJob])
    assert.equal(clock.nextDelayMs(), 1_000)

    clock.setNow('2026-07-17T01:00:01.000Z')
    clock.fire()
    await flushTimerMutation(runtime)

    assert.deepEqual(await store.load(), [])
    assert.deepEqual(await runtime.list(), [])
    assert.equal(eventQueue.size(), 1)
    assert.equal(eventQueue.dequeue()?.type, 'scheduled_wake')
    assert.equal(eventQueue.size(), 0)
  })

  test('removes a recurring job after the current wake reaches maxRuns', async () => {
    const clock = new FakeClock()
    const store = new RecordingStore([everyJob({ maxRuns: 1 })])
    const { runtime, eventQueue } = harness({ clock, store })
    await runtime.start()
    clock.setNow('2026-07-14T01:10:00.000Z')

    clock.fire()
    await flushTimerMutation(runtime)

    const event = eventQueue.dequeue()
    assert.equal(event?.type, 'scheduled_wake')
    assert.equal(event?.runCount, 1)
    assert.deepEqual(await runtime.list(), [])
    assert.equal(clock.timerCount(), 0)
  })

  test('fires a live at timer only after durable removal', async () => {
    const clock = new FakeClock()
    const store = new RecordingStore([atJob()])
    const { runtime, eventQueue } = harness({ clock, store })
    await runtime.start()
    clock.setNow('2026-07-14T01:10:00.000Z')

    clock.fire()
    await flushTimerMutation(runtime)

    assert.deepEqual(await store.load(), [])
    assert.deepEqual(await runtime.list(), [])
    assert.equal(eventQueue.size(), 1)
    assert.equal(clock.timerCount(), 0)
  })

  test('re-arms an early callback and ignores a stale callback after cancellation', async () => {
    const clock = new FakeClock()
    const { runtime, eventQueue } = harness({ clock, store: new RecordingStore([atJob()]) })
    await runtime.start()
    const staleCallback = clock.capture()
    clock.setNow('2026-07-14T01:05:00.000Z')

    clock.fire()
    await flushTimerMutation(runtime)
    assert.equal(eventQueue.size(), 0)
    assert.equal(clock.timerCount(), 1)
    assert.equal(clock.nextDelayMs(), 5 * 60_000)

    await runtime.cancel('schedule-1')
    staleCallback()
    await flushTimerMutation(runtime)
    assert.equal(eventQueue.size(), 0)
    assert.equal(clock.timerCount(), 0)
  })

  test('retries the same tick after persistence failure without publishing early', async () => {
    const clock = new FakeClock()
    const store = new RecordingStore([atJob()])
    const logs: Array<{ event: string; scheduleId: string; error: unknown }> = []
    const { runtime, eventQueue } = harness({
      clock,
      store,
      retryDelayMs: 1_000,
      logger: (entry) => logs.push(entry),
    })
    await runtime.start()
    store.failNextReplace = new Error('temporary write failure')
    clock.setNow('2026-07-14T01:10:00.000Z')

    clock.fire()
    await flushTimerMutation(runtime)
    assert.equal(eventQueue.size(), 0)
    assert.deepEqual((await runtime.list()).map((job) => job.id), ['schedule-1'])
    assert.equal(clock.nextDelayMs(), 1_000)
    assert.equal(logs[0]?.event, 'schedule_timer_failed')

    clock.setNow('2026-07-14T01:10:01.000Z')
    clock.fire()
    await flushTimerMutation(runtime)
    assert.equal(eventQueue.size(), 1)
    assert.deepEqual(await runtime.list(), [])
  })

  test('does not roll back or repeat a committed tick when enqueue throws', async () => {
    class FailingEventQueue extends InMemoryEventQueue<BotEvent> {
      override enqueue(): number {
        throw new Error('queue closed')
      }
    }
    const clock = new FakeClock()
    const logs: Array<{ event: string; scheduleId: string; error: unknown }> = []
    const queue = new FailingEventQueue()
    const store = new RecordingStore([atJob()])
    const { runtime } = harness({
      clock,
      store,
      eventQueue: queue,
      logger: (entry) => logs.push(entry),
    })
    await runtime.start()
    const staleCallback = clock.capture()
    clock.setNow('2026-07-14T01:10:00.000Z')

    clock.fire()
    await flushTimerMutation(runtime)
    staleCallback()
    await flushTimerMutation(runtime)

    assert.deepEqual(await store.load(), [])
    assert.deepEqual(await runtime.list(), [])
    assert.equal(logs.filter((entry) => entry.event === 'schedule_event_enqueue_failed').length, 1)
  })

  test('clears callbacks on stop and makes a captured stale callback harmless', async () => {
    const clock = new FakeClock()
    const store = new RecordingStore([atJob()])
    const { runtime, eventQueue } = harness({ clock, store })
    await runtime.start()
    const staleCallback = clock.capture()

    await runtime.stop()
    clock.setNow('2026-07-14T01:10:00.000Z')
    staleCallback()
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(clock.timerCount(), 0)
    assert.equal(eventQueue.size(), 0)
    assert.deepEqual(await store.load(), [atJob()])
  })

  test('clears a pending persistence retry during stop', async () => {
    const clock = new FakeClock()
    const store = new RecordingStore([atJob()])
    const { runtime, eventQueue } = harness({ clock, store, retryDelayMs: 1_000 })
    await runtime.start()
    store.failNextReplace = new Error('temporary write failure')
    clock.setNow('2026-07-14T01:10:00.000Z')
    clock.fire()
    await flushTimerMutation(runtime)
    const staleRetry = clock.capture()

    await runtime.stop()
    staleRetry()
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(clock.timerCount(), 0)
    assert.equal(eventQueue.size(), 0)
    assert.deepEqual(await store.load(), [atJob()])
  })
})
