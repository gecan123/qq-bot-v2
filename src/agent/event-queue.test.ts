import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from './event-queue.js'

describe('InMemoryEventQueue', () => {
  test('enqueue then dequeue returns events in FIFO order', () => {
    const q = new InMemoryEventQueue<string>()
    assert.equal(q.size(), 0)
    q.enqueue('a')
    q.enqueue('b')
    q.enqueue('c')
    assert.equal(q.size(), 3)
    assert.equal(q.dequeue(), 'a')
    assert.equal(q.dequeue(), 'b')
    assert.equal(q.dequeue(), 'c')
    assert.equal(q.dequeue(), null)
  })

  test('waitForEvent resolves immediately when queue is non-empty', async () => {
    const q = new InMemoryEventQueue<number>()
    q.enqueue(1)
    await q.waitForEvent()
    assert.equal(q.size(), 1, 'waitForEvent should not consume the event')
  })

  test('waitForEvent blocks until next enqueue', async () => {
    const q = new InMemoryEventQueue<string>()
    let resolved = false
    const waiting = q.waitForEvent().then(() => {
      resolved = true
    })
    await tick()
    assert.equal(resolved, false, 'waitForEvent should still be pending')
    q.enqueue('x')
    await waiting
    assert.equal(resolved, true)
  })

  test('enqueue wakes all waiters', async () => {
    const q = new InMemoryEventQueue<string>()
    let wokeA = false
    let wokeB = false
    const a = q.waitForEvent().then(() => {
      wokeA = true
    })
    const b = q.waitForEvent().then(() => {
      wokeB = true
    })
    q.enqueue('one')
    await Promise.all([a, b])
    assert.equal(wokeA, true)
    assert.equal(wokeB, true)
  })

  test('waitForEventWhere ignores non-matching events and resolves on a matching event without consuming', async () => {
    const q = new InMemoryEventQueue<number>()
    let resolved = false
    const waiting = q.waitForEventWhere((event) => event === 2).then(() => {
      resolved = true
    })

    q.enqueue(1)
    await tick()
    assert.equal(resolved, false)

    q.enqueue(2)
    await waiting
    assert.equal(resolved, true)
    assert.equal(q.size(), 2)
  })

  test('waitForEventWhere can be aborted before a matching event arrives', async () => {
    const q = new InMemoryEventQueue<number>()
    const abort = new AbortController()
    let resolvedCount = 0
    const waiting = q.waitForEventWhere((event) => event === 2, { signal: abort.signal }).then(() => {
      resolvedCount++
    })

    abort.abort()
    await waiting
    assert.equal(resolvedCount, 1)

    q.enqueue(2)
    await tick()
    assert.equal(resolvedCount, 1)
  })

  test('clear empties the queue and returns count', () => {
    const q = new InMemoryEventQueue<number>()
    q.enqueue(1)
    q.enqueue(2)
    q.enqueue(3)
    const cleared = q.clear()
    assert.equal(cleared, 3)
    assert.equal(q.size(), 0)
    assert.equal(q.dequeue(), null)
  })
})

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
