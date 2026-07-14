import { randomUUID } from 'node:crypto'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import {
  computeNextRunAt,
  normalizeScheduleSpec,
  SCHEDULE_LIMITS,
  type ScheduleSpec,
} from './schedule-model.js'
import type { ScheduleJob, ScheduleStore } from './schedule-store.js'

export interface CreateScheduleInput {
  name: string
  intention: string
  schedule: unknown
  maxRuns?: number
}

export type CreateScheduleResult =
  | { status: 'created'; schedule: ScheduleJob }
  | { status: 'existing'; schedule: ScheduleJob }

export type CancelScheduleResult =
  | { status: 'cancelled'; id: string }
  | { status: 'already_absent'; id: string }

export type ScheduleRuntimeErrorCode =
  | 'not_started'
  | 'already_started'
  | 'stopped'
  | 'invalid_input'
  | 'name_conflict'
  | 'active_limit_reached'
  | 'outside_schedule_window'

export class ScheduleRuntimeError extends Error {
  readonly code: ScheduleRuntimeErrorCode

  constructor(code: ScheduleRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ScheduleRuntimeError'
    this.code = code
  }
}

export interface ScheduleRuntime {
  start(): Promise<void>
  create(input: CreateScheduleInput): Promise<CreateScheduleResult>
  list(): Promise<ScheduleJob[]>
  cancel(id: string): Promise<CancelScheduleResult>
  stop(): Promise<void>
}

export interface ScheduleRuntimeLogEntry {
  event: 'schedule_timer_failed' | 'schedule_event_enqueue_failed'
  scheduleId: string
  error: unknown
}

export interface ScheduleRuntimeDependencies {
  store: ScheduleStore
  eventQueue: EventQueue<BotEvent>
  now?: () => Date
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  createId?: () => string
  logger?: (entry: ScheduleRuntimeLogEntry) => void
  retryDelayMs?: number
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

type RuntimeState = 'new' | 'starting' | 'started' | 'stopped'

interface ArmedTimer {
  handle: unknown
  expectedNextRunAt: string
}

export function createScheduleRuntime(
  dependencies: ScheduleRuntimeDependencies,
): ScheduleRuntime {
  const now = dependencies.now ?? (() => new Date())
  const setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = dependencies.clearTimer ?? ((handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  })
  const createId = dependencies.createId ?? randomUUID
  const logger = dependencies.logger
  const retryDelayMs = dependencies.retryDelayMs ?? 5_000

  let state: RuntimeState = 'new'
  let stopRequested = false
  let jobs = new Map<string, ScheduleJob>()
  const timers = new Map<string, ArmedTimer>()
  let mutationTail: Promise<void> = Promise.resolve()
  let stopPromise: Promise<void> | null = null

  const enqueueMutation = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = mutationTail.then(operation)
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const clearJobTimer = (id: string): void => {
    const timer = timers.get(id)
    if (!timer) return
    timers.delete(id)
    clearTimer(timer.handle)
  }

  const armJob = (job: ScheduleJob): void => {
    clearJobTimer(job.id)
    if (state !== 'started' || stopRequested) return
    const delayMs = Math.max(0, Date.parse(job.nextRunAt) - now().getTime())
    const expectedNextRunAt = job.nextRunAt
    const handle = setTimer(() => {
      queueTimerMutation(job.id, expectedNextRunAt)
    }, Math.min(delayMs, MAX_TIMER_DELAY_MS))
    timers.set(job.id, { handle, expectedNextRunAt })
  }

  const log = (entry: ScheduleRuntimeLogEntry): void => {
    try {
      logger?.(entry)
    } catch {
      // Logging must not affect durable schedule state or create unhandled rejections.
    }
  }

  const publish = (event: Extract<BotEvent, { type: 'scheduled_wake' }>): void => {
    try {
      dependencies.eventQueue.enqueue(event)
    } catch (error) {
      log({
        event: 'schedule_event_enqueue_failed',
        scheduleId: event.scheduleId,
        error,
      })
    }
  }

  const replacePublishedJobs = (nextJobs: readonly ScheduleJob[]): void => {
    jobs = new Map(nextJobs.map((job) => [job.id, cloneJob(job)]))
  }

  const armRetrySegment = (
    job: ScheduleJob,
    expectedNextRunAt: string,
    retryTargetAtMs: number,
  ): void => {
    clearJobTimer(job.id)
    if (
      state !== 'started' ||
      stopRequested ||
      jobs.get(job.id)?.nextRunAt !== expectedNextRunAt
    ) return
    const remainingMs = Math.max(0, retryTargetAtMs - now().getTime())
    const handle = setTimer(() => {
      queueRetryTimerMutation(job.id, expectedNextRunAt, retryTargetAtMs)
    }, Math.min(remainingMs, MAX_TIMER_DELAY_MS))
    timers.set(job.id, { handle, expectedNextRunAt })
  }

  const scheduleRetry = (job: ScheduleJob, expectedNextRunAt: string): void => {
    armRetrySegment(job, expectedNextRunAt, now().getTime() + retryDelayMs)
  }

  const processRetryTimer = async (
    id: string,
    expectedNextRunAt: string,
    retryTargetAtMs: number,
  ): Promise<void> => {
    if (state !== 'started' || stopRequested) return
    const job = jobs.get(id)
    if (!job || job.nextRunAt !== expectedNextRunAt) return
    if (now().getTime() < retryTargetAtMs) {
      armRetrySegment(job, expectedNextRunAt, retryTargetAtMs)
      return
    }
    await processTimer(id, expectedNextRunAt)
  }

  const processTimer = async (id: string, expectedNextRunAt: string): Promise<void> => {
    if (state !== 'started' || stopRequested) return
    const job = jobs.get(id)
    if (!job || job.nextRunAt !== expectedNextRunAt) return

    const currentTime = now()
    if (currentTime.getTime() < Date.parse(expectedNextRunAt)) {
      armJob(job)
      return
    }

    try {
      const advancement = advanceDueJob(job, currentTime, {
        allowLateLiveExpiry: true,
      })
      const nextJobs = advancement.job
        ? [...jobs.values()].map((currentJob) =>
            currentJob.id === id ? advancement.job! : currentJob,
          )
        : [...jobs.values()].filter((currentJob) => currentJob.id !== id)
      await dependencies.store.replace(nextJobs)
      replacePublishedJobs(nextJobs)
      clearJobTimer(id)
      if (advancement.job) armJob(advancement.job)
      if (advancement.event) publish(advancement.event)
    } catch (error) {
      log({ event: 'schedule_timer_failed', scheduleId: id, error })
      const currentJob = jobs.get(id)
      if (currentJob?.nextRunAt === expectedNextRunAt) {
        scheduleRetry(currentJob, expectedNextRunAt)
      }
    }
  }

  function queueTimerMutation(id: string, expectedNextRunAt: string): void {
    void enqueueMutation(() => processTimer(id, expectedNextRunAt)).catch((error: unknown) => {
      log({ event: 'schedule_timer_failed', scheduleId: id, error })
    })
  }

  function queueRetryTimerMutation(
    id: string,
    expectedNextRunAt: string,
    retryTargetAtMs: number,
  ): void {
    void enqueueMutation(() =>
      processRetryTimer(id, expectedNextRunAt, retryTargetAtMs),
    ).catch((error: unknown) => {
      log({ event: 'schedule_timer_failed', scheduleId: id, error })
    })
  }

  const requireStarted = (): void => {
    if (state === 'stopped') {
      throw new ScheduleRuntimeError('stopped', 'Schedule runtime has stopped')
    }
    if (state !== 'started') {
      throw new ScheduleRuntimeError('not_started', 'Schedule runtime has not started')
    }
  }

  const sortedSnapshot = (): ScheduleJob[] => {
    return cloneJobs([...jobs.values()].sort(compareJobs))
  }

  const runtime: ScheduleRuntime = {
    start() {
      if (state === 'stopped' || stopRequested) {
        return Promise.reject(new ScheduleRuntimeError('stopped', 'Schedule runtime has stopped'))
      }
      if (state !== 'new') {
        return Promise.reject(
          new ScheduleRuntimeError('already_started', 'Schedule runtime start was already requested'),
        )
      }
      state = 'starting'

      return enqueueMutation(async () => {
        try {
          const loaded = await dependencies.store.load()
          if (stopRequested) {
            throw new ScheduleRuntimeError('stopped', 'Schedule runtime has stopped')
          }
          const recovery = recoverLoadedJobs(loaded, now())
          if (recovery.changed) {
            await dependencies.store.replace(recovery.jobs)
            if (stopRequested) {
              await dependencies.store.replace(loaded)
              throw new ScheduleRuntimeError('stopped', 'Schedule runtime has stopped')
            }
          }
          replacePublishedJobs(recovery.jobs)
          state = 'started'
          for (const job of jobs.values()) armJob(job)
          for (const event of recovery.events) publish(event)
        } catch (error) {
          for (const id of timers.keys()) clearJobTimer(id)
          jobs = new Map()
          state = 'new'
          throw error
        }
      })
    },

    create(input) {
      return enqueueMutation(async () => {
        requireStarted()
        const name = normalizeRequiredText(input.name, 'name')
        const intention = normalizeRequiredText(input.intention, 'intention')
        if (
          input.maxRuns !== undefined &&
          (!Number.isInteger(input.maxRuns) || input.maxRuns <= 0)
        ) {
          throw new ScheduleRuntimeError(
            'invalid_input',
            'maxRuns must be a positive integer when provided',
          )
        }

        const existing = [...jobs.values()].find((job) => job.name === name)
        const normalizationTime = existing ? new Date(existing.createdAt) : now()
        const schedule = normalizeScheduleSpec(input.schedule, normalizationTime)
        if (existing) {
          if (
            existing.intention === intention &&
            schedulesEqual(existing.schedule, schedule) &&
            existing.maxRuns === input.maxRuns
          ) {
            return { status: 'existing', schedule: cloneJob(existing) }
          }
          throw new ScheduleRuntimeError(
            'name_conflict',
            `An active schedule named ${JSON.stringify(name)} already exists`,
          )
        }

        if (jobs.size >= SCHEDULE_LIMITS.maxActiveSchedules) {
          throw new ScheduleRuntimeError(
            'active_limit_reached',
            `At most ${SCHEDULE_LIMITS.maxActiveSchedules} schedules may be active`,
          )
        }

        const createdAt = normalizationTime
        const expiresAt = new Date(createdAt.getTime() + SCHEDULE_LIMITS.maxLifetimeMs)
        const nextRunAt = computeNextRunAt(schedule, createdAt)
        if (!nextRunAt || nextRunAt.getTime() > expiresAt.getTime()) {
          throw new ScheduleRuntimeError(
            'outside_schedule_window',
            'The schedule has no trigger within its three-day lifetime',
          )
        }

        const scheduleJob: ScheduleJob = {
          id: createId(),
          name,
          intention,
          schedule,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          nextRunAt: nextRunAt.toISOString(),
          runCount: 0,
          ...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
        }
        const nextJobs = [...jobs.values(), scheduleJob]
        await dependencies.store.replace(nextJobs)
        replacePublishedJobs(nextJobs)
        armJob(scheduleJob)
        return { status: 'created', schedule: cloneJob(scheduleJob) }
      })
    },

    list() {
      return enqueueMutation(() => {
        requireStarted()
        return sortedSnapshot()
      })
    },

    cancel(id) {
      return enqueueMutation(async () => {
        requireStarted()
        const existing = jobs.get(id)
        if (!existing) return { status: 'already_absent', id }

        const nextJobs = [...jobs.values()].filter((job) => job.id !== id)
        await dependencies.store.replace(nextJobs)
        replacePublishedJobs(nextJobs)
        clearJobTimer(id)
        return { status: 'cancelled', id }
      })
    },

    stop() {
      if (state === 'stopped') return Promise.resolve()
      if (stopPromise) return stopPromise
      stopRequested = true
      if (state === 'new') {
        state = 'stopped'
        return Promise.resolve()
      }
      stopPromise = enqueueMutation(() => {
        state = 'stopped'
        for (const id of [...timers.keys()]) clearJobTimer(id)
      })
      return stopPromise
    },
  }

  return runtime
}

function normalizeRequiredText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ScheduleRuntimeError('invalid_input', `${field} must not be blank`)
  }
  return value.trim()
}

function schedulesEqual(left: ScheduleSpec, right: ScheduleSpec): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function compareJobs(left: ScheduleJob, right: ScheduleJob): number {
  return (
    Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt) ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id.localeCompare(right.id)
  )
}

function cloneJob(job: ScheduleJob): ScheduleJob {
  return structuredClone(job) as ScheduleJob
}

function cloneJobs(jobs: readonly ScheduleJob[]): ScheduleJob[] {
  return structuredClone(jobs) as ScheduleJob[]
}

interface JobAdvancement {
  job: ScheduleJob | null
  event: Extract<BotEvent, { type: 'scheduled_wake' }> | null
}

interface StartupRecovery {
  jobs: ScheduleJob[]
  events: Array<Extract<BotEvent, { type: 'scheduled_wake' }>>
  changed: boolean
}

function recoverLoadedJobs(loaded: readonly ScheduleJob[], now: Date): StartupRecovery {
  const jobs: ScheduleJob[] = []
  const events: StartupRecovery['events'] = []
  let changed = false

  for (const persistedJob of loaded) {
    const job = cloneJob(persistedJob)
    const expiresAtMs = Date.parse(job.expiresAt)
    if (now.getTime() > expiresAtMs) {
      changed = true
      continue
    }
    if (Date.parse(job.nextRunAt) > now.getTime()) {
      jobs.push(job)
      continue
    }

    const advancement = advanceDueJob(job, now)
    changed = true
    if (advancement.job) jobs.push(advancement.job)
    if (advancement.event) events.push(advancement.event)
  }

  return { jobs, events, changed }
}

function advanceDueJob(
  job: ScheduleJob,
  now: Date,
  options: { allowLateLiveExpiry?: boolean } = {},
): JobAdvancement {
  const expiresAtMs = Date.parse(job.expiresAt)
  const nextRunAtMs = Date.parse(job.nextRunAt)
  const canAdvancePastExpiry =
    options.allowLateLiveExpiry === true &&
    (job.schedule.kind === 'at' ? nextRunAtMs === expiresAtMs : nextRunAtMs <= expiresAtMs)
  if (now.getTime() > expiresAtMs && !canAdvancePastExpiry) {
    return { job: null, event: null }
  }

  const expected = new Date(job.nextRunAt)
  if (expected.getTime() > now.getTime()) {
    return { job: cloneJob(job), event: null }
  }

  if (job.schedule.kind === 'at') {
    return {
      job: null,
      event: scheduleEvent(job, expected, job.runCount + 1),
    }
  }

  const expiryMs = expiresAtMs
  const latestAllowedMs = Math.min(now.getTime(), expiryMs)
  let latestOccurrence = expected
  let nextOccurrence = computeNextRunAt(job.schedule, latestOccurrence)
  while (nextOccurrence && nextOccurrence.getTime() <= latestAllowedMs) {
    latestOccurrence = nextOccurrence
    nextOccurrence = computeNextRunAt(job.schedule, latestOccurrence)
  }

  const runCount = job.runCount + 1
  const event = scheduleEvent(job, latestOccurrence, runCount)
  if (
    (job.maxRuns !== undefined && runCount >= job.maxRuns) ||
    nextOccurrence === null ||
    nextOccurrence.getTime() > expiryMs
  ) {
    return { job: null, event }
  }

  return {
    job: {
      ...cloneJob(job),
      lastRunAt: latestOccurrence.toISOString(),
      nextRunAt: nextOccurrence.toISOString(),
      runCount,
    },
    event,
  }
}

function scheduleEvent(
  job: ScheduleJob,
  scheduledFor: Date,
  runCount: number,
): Extract<BotEvent, { type: 'scheduled_wake' }> {
  return {
    type: 'scheduled_wake',
    scheduleId: job.id,
    name: job.name,
    scheduleKind: job.schedule.kind,
    scheduledFor: new Date(scheduledFor),
    intention: job.intention,
    runCount,
  }
}
