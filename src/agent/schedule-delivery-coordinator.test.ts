import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { createScheduleDeliveryCoordinator } from './schedule-delivery-coordinator.js'
import type { ScheduleDeliveryStore } from './schedule-delivery-store.js'
import type { ScheduleOccurrence } from './schedule-occurrence-store.js'

function occurrence(scheduleId: string): ScheduleOccurrence {
  return {
    scheduleId,
    name: `schedule ${scheduleId}`,
    intention: `open ${scheduleId}`,
    scheduledFor: '2026-08-03T12:00:00.000Z',
  }
}

function createFakeDeliveryStore(initial: readonly ScheduleOccurrence[]) {
  const pending = new Map(initial.map((item) => [item.scheduleId, structuredClone(item)]))
  const completed: string[] = []
  const store: ScheduleDeliveryStore = {
    async recordPending(item) { pending.set(item.scheduleId, structuredClone(item)) },
    async loadPending() { return [...pending.values()].map((item) => structuredClone(item)) },
    async complete(scheduleId) {
      completed.push(scheduleId)
      pending.delete(scheduleId)
    },
  }
  return { store, pending, completed }
}

describe('createScheduleDeliveryCoordinator', () => {
  test('replays only uncommitted inactive deliveries and deduplicates the live queue', async () => {
    const target = new InMemoryEventQueue<BotEvent>()
    const deliveries = createFakeDeliveryStore([
      occurrence('active'),
      occurrence('committed'),
      occurrence('replay'),
    ])
    const coordinator = createScheduleDeliveryCoordinator({
      eventQueue: target,
      deliveryStore: deliveries.store,
      isCommitted: async (event) => event.scheduleId === 'committed',
    })

    await coordinator.replayPending(new Set(['active']))

    assert.deepEqual(deliveries.completed, ['committed'])
    assert.equal(target.size(), 1)
    assert.equal(target.dequeue()?.type, 'scheduled_wake')
    assert.equal(deliveries.pending.has('active'), true)
    assert.equal(deliveries.pending.has('committed'), false)
    assert.equal(deliveries.pending.has('replay'), true)

    coordinator.eventQueue.enqueue({
      type: 'scheduled_wake',
      scheduleId: 'live',
      name: 'live schedule',
      scheduledFor: new Date('2026-08-03T12:00:00.000Z'),
    })
    coordinator.eventQueue.enqueue({
      type: 'scheduled_wake',
      scheduleId: 'live',
      name: 'live schedule',
      scheduledFor: new Date('2026-08-03T12:00:00.000Z'),
    })
    assert.equal(target.size(), 1)
  })

  test('removes pending deliveries only after their scheduled wake is committed', async () => {
    const target = new InMemoryEventQueue<BotEvent>()
    const deliveries = createFakeDeliveryStore([occurrence('done'), occurrence('other')])
    const coordinator = createScheduleDeliveryCoordinator({
      eventQueue: target,
      deliveryStore: deliveries.store,
      isCommitted: async () => false,
    })

    await coordinator.markCommitted([
      { type: 'wake' },
      {
        type: 'scheduled_wake',
        scheduleId: 'done',
        name: 'done schedule',
        scheduledFor: new Date('2026-08-03T12:00:00.000Z'),
      },
    ])

    assert.deepEqual(deliveries.completed, ['done'])
    assert.deepEqual([...deliveries.pending.keys()], ['other'])
  })
})
