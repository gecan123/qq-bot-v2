import type { BackgroundTask, BackgroundTaskRegistry } from './background-task-registry.js'
import type { BotEvent } from './event.js'
import type { EventQueue } from './event-queue.js'
import { formatBeijingIso } from '../utils/beijing-time.js'
import { createLogger } from '../logger.js'

const log = createLogger('DURABLE_WAKE')
export const SCHEDULED_WAKE_RECOVERY_KIND = 'scheduled_wake.v1'

interface TimerPort {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ScheduledWake {
  id: string
  reason: string
  dueAt: Date
  startedAt: Date
}

export interface DurableWakeScheduler {
  schedule(input: { delaySeconds: number; reason: string }): ScheduledWake
  list(): ScheduledWake[]
  cancel(id: string): boolean
  stop(): void
}

export interface CreateDurableWakeSchedulerInput {
  registry: BackgroundTaskRegistry
  eventQueue: EventQueue<BotEvent>
  now?: () => Date
  timer?: TimerPort
}

const defaultTimer: TimerPort = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createDurableWakeScheduler(
  input: CreateDurableWakeSchedulerInput,
): DurableWakeScheduler {
  const now = input.now ?? (() => new Date())
  const timer = input.timer ?? defaultTimer
  const handles = new Map<string, unknown>()
  let stopped = false

  function arm(task: BackgroundTask): void {
    const wake = parseScheduledWake(task)
    if (!wake || stopped || handles.has(task.id)) return
    const delayMs = Math.max(0, wake.dueAt.getTime() - now().getTime())
    const handle = timer.setTimeout(() => {
      handles.delete(task.id)
      if (stopped || input.registry.get(task.id)?.status !== 'running') return
      input.eventQueue.enqueue({
        type: 'scheduled_wake',
        scheduleId: task.id,
        dueAt: wake.dueAt,
        reason: wake.reason,
      })
      input.registry.complete(task.id, {
        summary: `定时唤醒已触发: ${wake.reason}`,
        data: { dueAt: formatBeijingIso(wake.dueAt), reason: wake.reason },
      })
      log.info({ scheduleId: task.id, dueAt: formatBeijingIso(wake.dueAt) }, 'scheduled_wake_fired')
    }, delayMs)
    handles.set(task.id, handle)
    log.info({ scheduleId: task.id, delayMs, dueAt: formatBeijingIso(wake.dueAt) }, 'scheduled_wake_armed')
  }

  for (const task of input.registry.listRunning()) arm(task)

  return {
    schedule({ delaySeconds, reason }) {
      if (stopped) throw new Error('durable wake scheduler is stopped')
      const startedAt = now()
      const dueAt = new Date(startedAt.getTime() + delaySeconds * 1000)
      const task = input.registry.register({
        toolName: 'schedule',
        description: `定时唤醒: ${reason}`,
        recovery: {
          kind: SCHEDULED_WAKE_RECOVERY_KIND,
          payload: { dueAt: formatBeijingIso(dueAt), reason },
        },
      })
      arm(task)
      return { id: task.id, reason, dueAt, startedAt }
    },

    list() {
      return input.registry.listRunning().flatMap((task) => {
        const wake = parseScheduledWake(task)
        return wake ? [wake] : []
      })
    },

    cancel(id) {
      const task = input.registry.get(id)
      if (!task || !parseScheduledWake(task)) return false
      const changed = input.registry.cancel(id, 'scheduled_wake_cancelled')
      if (!changed) return false
      const handle = handles.get(id)
      if (handle !== undefined) timer.clearTimeout(handle)
      handles.delete(id)
      return true
    },

    stop() {
      stopped = true
      for (const handle of handles.values()) timer.clearTimeout(handle)
      handles.clear()
    },
  }
}

function parseScheduledWake(task: BackgroundTask): ScheduledWake | null {
  if (task.status !== 'running' || task.recovery?.kind !== SCHEDULED_WAKE_RECOVERY_KIND) return null
  const payload = task.recovery.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const dueAtRaw = payload.dueAt
  const reason = payload.reason
  if (typeof dueAtRaw !== 'string' || typeof reason !== 'string') return null
  const dueAt = new Date(dueAtRaw)
  if (!Number.isFinite(dueAt.getTime())) return null
  return { id: task.id, reason, dueAt, startedAt: task.startedAt }
}
