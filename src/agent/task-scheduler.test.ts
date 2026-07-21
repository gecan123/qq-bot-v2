import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AGENT_TASK_LANES, createTaskScheduler } from './task-scheduler.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('task scheduler', () => {
  test('default agent lanes contain only active specialized workers', () => {
    assert.deepEqual(Object.keys(AGENT_TASK_LANES), [
      'maintenance',
      'network',
      'media-description',
    ])
  })

  test('enforces lane concurrency while allowing bounded parallel work', async () => {
    const scheduler = createTaskScheduler({ network: { concurrency: 2 } })
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
    const thirdStarted = deferred<void>()
    let active = 0
    let maxActive = 0
    const started: number[] = []

    const tasks = gates.map((gate, index) => scheduler.schedule({ lane: 'network' }, async () => {
      started.push(index)
      if (index === 2) thirdStarted.resolve()
      active++
      maxActive = Math.max(maxActive, active)
      await gate.promise
      active--
      return index
    }))

    assert.deepEqual(started, [0, 1])
    gates[0]!.resolve()
    await thirdStarted.promise
    assert.deepEqual(started, [0, 1, 2])
    gates[1]!.resolve()
    gates[2]!.resolve()
    assert.deepEqual(await Promise.all(tasks), [0, 1, 2])
    assert.equal(maxActive, 2)
  })

  test('serializes the same resource key across lanes', async () => {
    const scheduler = createTaskScheduler({ a: { concurrency: 2 }, b: { concurrency: 2 } })
    const gate = deferred<void>()
    const started: string[] = []

    const first = scheduler.schedule({ lane: 'a', resourceKey: 'repo:x' }, async () => {
      started.push('first')
      await gate.promise
    })
    const second = scheduler.schedule({ lane: 'b', resourceKey: 'repo:x' }, async () => {
      started.push('second')
    })

    assert.deepEqual(started, ['first'])
    gate.resolve()
    await first
    await second
    assert.deepEqual(started, ['first', 'second'])
  })

  test('shares one task for matching dedupe keys and drains queued work', async () => {
    const scheduler = createTaskScheduler({ housekeeping: { concurrency: 1 } })
    const gate = deferred<number>()
    let calls = 0
    const first = scheduler.schedule({ lane: 'housekeeping', dedupeKey: 'prune' }, async () => {
      calls++
      return gate.promise
    })
    const duplicate = scheduler.schedule({ lane: 'housekeeping', dedupeKey: 'prune' }, async () => {
      calls++
      return 99
    })
    const drained = scheduler.drain()

    assert.equal(first, duplicate)
    assert.equal(calls, 1)
    gate.resolve(42)
    assert.equal(await duplicate, 42)
    await drained
  })
})
