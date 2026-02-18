import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createMemoryQueue } from './memory-queue.js'

describe('createMemoryQueue', () => {
  test('processes jobs in order with interJobDelayMs=0', async () => {
    const queue = createMemoryQueue(0)
    const results: number[] = []

    queue.register('test-job', async (job) => {
      results.push((job.data as { n: number }).n)
    })

    queue.start()
    queue.enqueue('test-job', { n: 1 })
    queue.enqueue('test-job', { n: 2 })
    queue.enqueue('test-job', { n: 3 })

    await new Promise((resolve) => setTimeout(resolve, 200))
    queue.stop()

    assert.deepEqual(results, [1, 2, 3])
  })

  test('defaults to 0 delay when no argument provided', () => {
    // Just verify it constructs without error
    const queue = createMemoryQueue()
    queue.start()
    queue.stop()
  })
})
