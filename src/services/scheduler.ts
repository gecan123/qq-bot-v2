import type { Server } from 'node:http'
import type { BotEvent } from '../agent/event.js'
import type { EventQueue } from '../agent/event-queue.js'
import {
  createScheduleRuntime,
  ScheduleRuntimeError,
} from '../agent/schedule-runtime.js'
import { createPersistentScheduleStore } from '../agent/schedule-store.js'
import { createPersistentScheduleOccurrenceStore } from '../agent/schedule-occurrence-store.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { closeServer, requestJson, startJsonServer, writeJson } from './http.js'

const log = createLogger('SCHEDULER_SERVICE')
const pendingDeliveries = new Map<string, Extract<BotEvent, { type: 'scheduled_wake' }>>()
let deliveryTimer: ReturnType<typeof setTimeout> | null = null
let server: Server | null = null
let stopping = false

const deliveryQueue: EventQueue<BotEvent> = {
  enqueue(event) {
    if (event.type !== 'scheduled_wake') throw new Error(`unsupported scheduler event: ${event.type}`)
    pendingDeliveries.set(event.scheduleId, event)
    scheduleDelivery(0)
    return pendingDeliveries.size
  },
  dequeue: () => null,
  size: () => pendingDeliveries.size,
  clear() {
    const size = pendingDeliveries.size
    pendingDeliveries.clear()
    return size
  },
  waitForEvent: async () => undefined,
  waitForEventWhere: async () => undefined,
}

const runtime = createScheduleRuntime({
  store: createPersistentScheduleStore(config.scheduleStatePath),
  occurrenceStore: createPersistentScheduleOccurrenceStore(`${config.scheduleStatePath}.occurrences`),
  eventQueue: deliveryQueue,
  logger: (entry) => log.warn(entry, entry.event),
})

async function main(): Promise<void> {
  await runtime.start()
  server = await startJsonServer({
    baseUrl: config.services.schedulerUrl,
    async handler({ request, response, url, body }) {
      if (request.method === 'GET' && url.pathname === '/health') {
        return { ok: true, pendingDeliveries: pendingDeliveries.size }
      }
      if (request.method !== 'POST' || url.pathname !== '/schedule') {
        writeJson(response, 404, { ok: false, error: 'not found' })
        return
      }
      try {
        return { ok: true, value: await dispatchScheduleRequest(body) }
      } catch (error) {
        if (!(error instanceof ScheduleRuntimeError)) throw error
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.scheduleId ? { scheduleId: error.scheduleId } : {}),
          },
        }
      }
    },
  })
  log.info({ url: config.services.schedulerUrl }, 'scheduler_service_started')
}

async function dispatchScheduleRequest(body: unknown): Promise<unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('request object required')
  const request = body as Record<string, unknown>
  if (request.action === 'create') return runtime.create(request.input as never)
  if (request.action === 'list') return runtime.list()
  if (request.action === 'get_occurrence' && typeof request.scheduleId === 'string') {
    return runtime.getOccurrence(request.scheduleId)
  }
  if (request.action === 'cancel' && typeof request.id === 'string') return runtime.cancel(request.id)
  throw new ScheduleRuntimeError('invalid_input', 'invalid scheduler action')
}

function scheduleDelivery(delayMs: number): void {
  if (stopping || deliveryTimer) return
  deliveryTimer = setTimeout(() => {
    deliveryTimer = null
    void deliverPending()
  }, delayMs)
}

async function deliverPending(): Promise<void> {
  for (const [scheduleId, event] of pendingDeliveries) {
    if (stopping) return
    try {
      await requestJson({
        baseUrl: config.services.agentEventsUrl,
        path: '/events',
        method: 'POST',
        body: {
          event: {
            ...event,
            scheduledFor: event.scheduledFor.toISOString(),
          },
        },
        timeoutMs: 5_000,
      })
      pendingDeliveries.delete(scheduleId)
    } catch (error) {
      log.warn({ error, scheduleId }, 'scheduled_wake_delivery_failed_will_retry')
    }
  }
  if (pendingDeliveries.size > 0) scheduleDelivery(5_000)
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  log.info({ signal }, 'scheduler_service_shutdown_requested')
  if (deliveryTimer) clearTimeout(deliveryTimer)
  await runtime.stop()
  if (server) await closeServer(server).catch((error) => log.warn({ error }, 'scheduler_server_close_failed'))
}

process.once('SIGINT', () => void shutdown('SIGINT').finally(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown('SIGTERM').finally(() => process.exit(0)))

void main().catch(async (error) => {
  log.fatal({ error }, 'scheduler_service_start_failed')
  await shutdown('startup_failure')
  process.exitCode = 1
})
