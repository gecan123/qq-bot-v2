import { randomUUID } from 'node:crypto'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import {
  normalizeScheduleAt,
  ScheduleModelError,
  SCHEDULE_LIMITS,
  type ScheduleAtInput,
} from './schedule-model.js'
import { validateScheduleJobs, type ScheduleJob, type ScheduleStore } from './schedule-store.js'
import {
  createInMemoryScheduleOccurrenceStore,
  type ScheduleOccurrence,
  type ScheduleOccurrenceStore,
} from './schedule-occurrence-store.js'

export type CreateScheduleInput = ScheduleAtInput & {
  name: string
  intention: string
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
  | 'invalid_schedule'
  | 'name_conflict'
  | 'active_limit_reached'
  | 'outside_schedule_window'
  | 'persistence_failed'
  | 'timer_failed'

export interface ScheduleRuntimeErrorOptions extends ErrorOptions {
  scheduleId?: string
}

export class ScheduleRuntimeError extends Error {
  readonly code: ScheduleRuntimeErrorCode
  readonly scheduleId?: string

  constructor(code: ScheduleRuntimeErrorCode, message: string, options?: ScheduleRuntimeErrorOptions) {
    super(message, options)
    this.name = 'ScheduleRuntimeError'
    this.code = code
    this.scheduleId = options?.scheduleId
  }
}

export interface ScheduleRuntime {
  start(): Promise<void>
  create(input: CreateScheduleInput): Promise<CreateScheduleResult>
  list(): Promise<ScheduleJob[]>
  getOccurrence(scheduleId: string): Promise<ScheduleOccurrence | null>
  cancel(id: string): Promise<CancelScheduleResult>
  stop(): Promise<void>
}

export interface ScheduleRuntimeLogEntry {
  event: 'schedule_timer_failed' | 'schedule_processing_failed' | 'schedule_event_enqueue_failed'
  scheduleId: string
  error: unknown
}

export interface ScheduleRuntimeDependencies {
  store: ScheduleStore
  occurrenceStore?: ScheduleOccurrenceStore
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
  expectedAt: string
}

export function createScheduleRuntime(deps: ScheduleRuntimeDependencies): ScheduleRuntime {
  const now = deps.now ?? (() => new Date())
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const createId = deps.createId ?? randomUUID
  const occurrenceStore = deps.occurrenceStore ?? createInMemoryScheduleOccurrenceStore()
  const retryDelayMs = Math.max(1, deps.retryDelayMs ?? 5_000)

  let state: RuntimeState = 'new'
  let jobs = new Map<string, ScheduleJob>()
  const timers = new Map<string, ArmedTimer>()
  let mutationTail: Promise<void> = Promise.resolve()

  const enqueueMutation = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = mutationTail.then(operation)
    mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  const log = (entry: ScheduleRuntimeLogEntry): void => {
    try {
      deps.logger?.(entry)
    } catch {
      // Observability must not alter schedule state.
    }
  }

  const clearJobTimer = (id: string): void => {
    const timer = timers.get(id)
    if (!timer) return
    timers.delete(id)
    try {
      clearTimer(timer.handle)
    } catch (error) {
      log({ event: 'schedule_timer_failed', scheduleId: id, error })
    }
  }

  const queueTimer = (id: string, expectedAt: string): void => {
    void enqueueMutation(async () => {
      await processTimer(id, expectedAt)
    }).catch((error) => {
      log({ event: 'schedule_processing_failed', scheduleId: id, error })
      const job = jobs.get(id)
      if (state === 'started' && job?.at === expectedAt) {
        try {
          clearJobTimer(id)
          const handle = setTimer(() => queueTimer(id, expectedAt), retryDelayMs)
          timers.set(id, { handle, expectedAt })
        } catch (timerError) {
          log({ event: 'schedule_timer_failed', scheduleId: id, error: timerError })
        }
      }
    })
  }

  const armJob = (job: ScheduleJob): void => {
    clearJobTimer(job.id)
    if (state !== 'started') return
    const delayMs = Math.max(0, Date.parse(job.at) - now().getTime())
    const expectedAt = job.at
    const handle = setTimer(() => queueTimer(job.id, expectedAt), Math.min(delayMs, MAX_TIMER_DELAY_MS))
    timers.set(job.id, { handle, expectedAt })
  }

  const processTimer = async (id: string, expectedAt: string): Promise<void> => {
    if (state !== 'started') return
    const job = jobs.get(id)
    if (!job || job.at !== expectedAt) return
    if (now().getTime() < Date.parse(expectedAt)) {
      armJob(job)
      return
    }

    const occurrence: ScheduleOccurrence = {
      scheduleId: job.id,
      name: job.name,
      intention: job.intention,
      scheduledFor: job.at,
    }
    try {
      await occurrenceStore.record(occurrence)
      const nextJobs = [...jobs.values()].filter((candidate) => candidate.id !== id)
      await deps.store.replace(nextJobs)
      jobs = new Map(nextJobs.map((candidate) => [candidate.id, cloneJob(candidate)]))
    } catch (error) {
      throw new ScheduleRuntimeError('persistence_failed', 'Could not persist schedule firing', {
        cause: error,
        scheduleId: id,
      })
    }
    clearJobTimer(id)
    try {
      deps.eventQueue.enqueue({
        type: 'scheduled_wake',
        scheduleId: occurrence.scheduleId,
        name: occurrence.name,
        scheduledFor: new Date(occurrence.scheduledFor),
      })
    } catch (error) {
      log({ event: 'schedule_event_enqueue_failed', scheduleId: id, error })
    }
  }

  const assertStarted = (): void => {
    if (state === 'new') throw new ScheduleRuntimeError('not_started', 'Schedule runtime has not started')
    if (state === 'starting') throw new ScheduleRuntimeError('already_started', 'Schedule runtime is starting')
    if (state === 'stopped') throw new ScheduleRuntimeError('stopped', 'Schedule runtime has stopped')
  }

  return {
    async start() {
      if (state === 'starting' || state === 'started') {
        throw new ScheduleRuntimeError('already_started', 'Schedule runtime already started')
      }
      if (state === 'stopped') throw new ScheduleRuntimeError('stopped', 'Schedule runtime has stopped')
      state = 'starting'
      let loaded: ScheduleJob[]
      try {
        loaded = validateScheduleJobs(await deps.store.load())
      } catch (error) {
        state = 'new'
        throw new ScheduleRuntimeError('persistence_failed', 'Could not load schedules', { cause: error })
      }
      jobs = new Map(loaded.map((job) => [job.id, cloneJob(job)]))
      state = 'started'
      try {
        for (const job of jobs.values()) armJob(job)
      } catch (error) {
        for (const id of [...timers.keys()]) clearJobTimer(id)
        state = 'stopped'
        throw new ScheduleRuntimeError('timer_failed', 'Could not arm schedule timer', { cause: error })
      }
    },

    create(input) {
      return enqueueMutation(async () => {
        assertStarted()
        const name = normalizeText(input.name, SCHEDULE_LIMITS.maxNameLength, 'name')
        const intention = normalizeText(input.intention, SCHEDULE_LIMITS.maxIntentionLength, 'intention')
        const createdAtDate = now()
        let at: string
        try {
          at = normalizeScheduleAt(
            'at' in input ? { at: input.at } : { afterSeconds: input.afterSeconds },
            createdAtDate,
          )
        } catch (error) {
          if (!(error instanceof ScheduleModelError)) throw error
          throw new ScheduleRuntimeError(error.code, error.message, { cause: error })
        }
        const existing = [...jobs.values()].find((job) => job.name === name)
        if (existing) {
          if (existing.intention === intention && existing.at === at) {
            return { status: 'existing', schedule: cloneJob(existing) }
          }
          throw new ScheduleRuntimeError('name_conflict', 'A schedule with this name already exists', {
            scheduleId: existing.id,
          })
        }
        if (jobs.size >= SCHEDULE_LIMITS.maxActiveSchedules) {
          throw new ScheduleRuntimeError('active_limit_reached', 'Active schedule limit reached')
        }
        const createdAt = createdAtDate.toISOString()
        const job: ScheduleJob = { id: createId(), name, intention, at, createdAt }
        validateScheduleJobs([...jobs.values(), job])
        try {
          await deps.store.replace([...jobs.values(), job])
        } catch (error) {
          throw new ScheduleRuntimeError('persistence_failed', 'Could not persist schedule', { cause: error })
        }
        jobs.set(job.id, cloneJob(job))
        try {
          armJob(job)
        } catch (error) {
          throw new ScheduleRuntimeError('timer_failed', 'Could not arm schedule timer', {
            cause: error,
            scheduleId: job.id,
          })
        }
        return { status: 'created', schedule: cloneJob(job) }
      })
    },

    list() {
      return enqueueMutation(() => {
        assertStarted()
        return [...jobs.values()].map(cloneJob).sort((a, b) => a.at.localeCompare(b.at))
      })
    },

    getOccurrence(scheduleId) {
      return enqueueMutation(async () => {
        assertStarted()
        if (!scheduleId.trim() || scheduleId.length > SCHEDULE_LIMITS.maxIdLength) return null
        return await occurrenceStore.get(scheduleId)
      })
    },

    cancel(id) {
      return enqueueMutation(async () => {
        assertStarted()
        const existing = jobs.get(id)
        if (!existing) return { status: 'already_absent', id }
        const nextJobs = [...jobs.values()].filter((job) => job.id !== id)
        try {
          await deps.store.replace(nextJobs)
        } catch (error) {
          throw new ScheduleRuntimeError('persistence_failed', 'Could not persist cancellation', {
            cause: error,
            scheduleId: id,
          })
        }
        jobs.delete(id)
        clearJobTimer(id)
        return { status: 'cancelled', id }
      })
    },

    async stop() {
      if (state === 'stopped') return
      state = 'stopped'
      for (const id of [...timers.keys()]) clearJobTimer(id)
      await mutationTail
      jobs.clear()
    },
  }
}

function normalizeText(value: string, maxLength: number, field: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new ScheduleRuntimeError('invalid_input', `${field} is invalid`)
  }
  return normalized
}

function cloneJob(job: ScheduleJob): ScheduleJob {
  return { ...job }
}
