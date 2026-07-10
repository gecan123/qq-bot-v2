import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBackfillScheduler } from './startup-backfill.js'

test('initialBackfillDone resolves only after the first scheduled backfill completes', async () => {
  const order: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let calls = 0
  const scheduler = createBackfillScheduler(async () => {
    calls++
    order.push(`start:${calls}`)
    if (calls === 1) await firstGate
    order.push(`end:${calls}`)
  })

  const first = scheduler.schedule()
  let initialCompleted = false
  void scheduler.initialBackfillDone.then(() => {
    initialCompleted = true
  })
  await Promise.resolve()

  assert.equal(initialCompleted, false)
  releaseFirst()
  await first
  await scheduler.initialBackfillDone
  assert.deepEqual(order, ['start:1', 'end:1'])
})

test('reconnect backfills run serially without replacing the initial barrier', async () => {
  const order: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let calls = 0
  const scheduler = createBackfillScheduler(async () => {
    calls++
    const call = calls
    order.push(`start:${call}`)
    if (call === 1) await firstGate
    order.push(`end:${call}`)
  })

  const first = scheduler.schedule()
  const initialBarrier = scheduler.initialBackfillDone
  const reconnect = scheduler.schedule()
  assert.equal(scheduler.initialBackfillDone, initialBarrier)
  releaseFirst()
  await scheduler.initialBackfillDone

  await Promise.all([first, reconnect])
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2'])
})
