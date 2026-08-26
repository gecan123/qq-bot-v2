import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import {
  BackfillSourceTimeoutError,
  createBackfillScheduler,
  runBoundedBackfills,
} from './startup-backfill.js'

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

test('bounded backfills limit concurrent source work', async () => {
  let active = 0
  let maxActive = 0

  await runBoundedBackfills({
    sources: [1, 2, 3, 4],
    concurrency: 2,
    sourceTimeoutMs: 100,
    async run() {
      active++
      maxActive = Math.max(maxActive, active)
      await delay(5)
      active--
    },
    onFailure() {
      assert.fail('finite backfills should not fail')
    },
  })

  assert.equal(maxActive, 2)
})

test('bounded backfills time out a pending source and continue other sources', async () => {
  const completed: number[] = []
  const failures: Array<{ source: number; error: unknown }> = []

  await runBoundedBackfills({
    sources: [1, 2, 3],
    concurrency: 2,
    sourceTimeoutMs: 15,
    async run(source, signal) {
      if (source === 1) {
        await delay(30)
        signal.throwIfAborted()
      }
      await delay(1)
      completed.push(source)
    },
    onFailure(source, error) {
      failures.push({ source, error })
    },
  })
  await delay(20)

  assert.deepEqual(completed, [2, 3])
  assert.equal(failures.length, 1)
  assert.equal(failures[0]?.source, 1)
  assert.ok(failures[0]?.error instanceof BackfillSourceTimeoutError)
})
