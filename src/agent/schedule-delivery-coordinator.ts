import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { ScheduleDeliveryStore } from './schedule-delivery-store.js'

export interface ScheduleDeliveryCoordinator {
  eventQueue: EventQueue<BotEvent>
  replayPending(activeScheduleIds: ReadonlySet<string>): Promise<void>
  markCommitted(events: readonly BotEvent[]): Promise<void>
}

export function createScheduleDeliveryCoordinator(input: {
  eventQueue: EventQueue<BotEvent>
  deliveryStore: ScheduleDeliveryStore
  isCommitted: (event: Extract<BotEvent, { type: 'scheduled_wake' }>) => Promise<boolean>
}): ScheduleDeliveryCoordinator {
  const queuedScheduleIds = new Set<string>()
  const eventQueue: EventQueue<BotEvent> = {
    enqueue(event) {
      if (event.type !== 'scheduled_wake') return input.eventQueue.enqueue(event)
      if (queuedScheduleIds.has(event.scheduleId)) return input.eventQueue.size()
      const size = input.eventQueue.enqueue(event)
      queuedScheduleIds.add(event.scheduleId)
      return size
    },
    dequeue: () => input.eventQueue.dequeue(),
    size: () => input.eventQueue.size(),
    clear() {
      queuedScheduleIds.clear()
      return input.eventQueue.clear()
    },
    waitForEvent: (options) => input.eventQueue.waitForEvent(options),
    waitForEventWhere: (predicate, options) => input.eventQueue.waitForEventWhere(predicate, options),
  }

  return {
    eventQueue,
    async replayPending(activeScheduleIds) {
      for (const occurrence of await input.deliveryStore.loadPending()) {
        if (activeScheduleIds.has(occurrence.scheduleId)) continue
        const event: Extract<BotEvent, { type: 'scheduled_wake' }> = {
          type: 'scheduled_wake',
          scheduleId: occurrence.scheduleId,
          name: occurrence.name,
          scheduledFor: new Date(occurrence.scheduledFor),
        }
        if (await input.isCommitted(event)) {
          await input.deliveryStore.complete(event.scheduleId)
          queuedScheduleIds.delete(event.scheduleId)
          continue
        }
        eventQueue.enqueue(event)
      }
    },
    async markCommitted(events) {
      const scheduleIds = new Set(
        events
          .filter((event): event is Extract<BotEvent, { type: 'scheduled_wake' }> => event.type === 'scheduled_wake')
          .map((event) => event.scheduleId),
      )
      for (const scheduleId of scheduleIds) {
        await input.deliveryStore.complete(scheduleId)
        queuedScheduleIds.delete(scheduleId)
      }
    },
  }
}
