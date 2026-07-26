import type { Server } from 'node:http'
import type { BotEvent } from '../agent/event.js'
import { closeServer, startJsonServer, writeJson } from './http.js'

export interface AgentEventsServer {
  close(): Promise<void>
}

export async function startAgentEventsServer(input: {
  baseUrl: string
  enqueue: (event: BotEvent) => void
}): Promise<AgentEventsServer> {
  const acceptedSchedules = new Set<string>()
  const server: Server = await startJsonServer({
    baseUrl: input.baseUrl,
    handler({ request, response, url, body }) {
      if (request.method === 'GET' && url.pathname === '/health') return { ok: true }
      if (request.method === 'POST' && url.pathname === '/events') {
        const event = parsePlatformEvent(body)
        if (event.type === 'scheduled_wake') {
          if (acceptedSchedules.has(event.scheduleId)) {
            return { ok: true, duplicate: true }
          }
          acceptedSchedules.add(event.scheduleId)
        }
        input.enqueue(event)
        return { ok: true, duplicate: false }
      }
      writeJson(response, 404, { ok: false, error: 'not found' })
    },
  })
  return { close: () => closeServer(server) }
}

function parsePlatformEvent(body: unknown): Extract<BotEvent, { type: 'scheduled_wake' }> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('event object required')
  const envelope = body as Record<string, unknown>
  const raw = envelope.event
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('event object required')
  const event = raw as Record<string, unknown>
  if (
    event.type !== 'scheduled_wake'
    || typeof event.scheduleId !== 'string'
    || typeof event.name !== 'string'
    || typeof event.scheduledFor !== 'string'
  ) {
    throw new Error('unsupported platform event')
  }
  const scheduledFor = new Date(event.scheduledFor)
  if (!Number.isFinite(scheduledFor.getTime())) throw new Error('invalid scheduledFor')
  return {
    type: 'scheduled_wake',
    scheduleId: event.scheduleId,
    name: event.name,
    scheduledFor,
  }
}
