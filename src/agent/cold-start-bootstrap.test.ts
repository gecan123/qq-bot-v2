import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { enqueueColdStartBootstrap } from './cold-start-bootstrap.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'

describe('enqueueColdStartBootstrap', () => {
  test('enqueues bootstrap when snapshot and pending events are both absent', () => {
    const queue = new InMemoryEventQueue<BotEvent>()

    assert.equal(enqueueColdStartBootstrap(queue, false), true)
    assert.deepEqual(queue.dequeue(), { type: 'bootstrap' })
  })

  test('does nothing when a persisted snapshot exists', () => {
    const queue = new InMemoryEventQueue<BotEvent>()

    assert.equal(enqueueColdStartBootstrap(queue, true), false)
    assert.equal(queue.size(), 0)
  })

  test('does not precede a real event received during startup', () => {
    const queue = new InMemoryEventQueue<BotEvent>()
    queue.enqueue({ type: 'wake' })

    assert.equal(enqueueColdStartBootstrap(queue, false), false)
    assert.deepEqual(queue.dequeue(), { type: 'wake' })
  })
})
