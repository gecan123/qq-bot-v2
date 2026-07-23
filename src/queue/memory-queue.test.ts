import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { log } from '../logger.js'
import { createMemoryQueue } from './memory-queue.js'

const originalWarn = log.warn

afterEach(() => {
  log.warn = originalWarn
})

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

  test('runs high-priority jobs before queued low-priority jobs', async () => {
    const queue = createMemoryQueue(0)
    const results: number[] = []
    let releaseFirst!: () => void
    const firstJobDone = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    queue.register('test-job', async (job) => {
      const n = (job.data as { n: number }).n
      results.push(n)
      if (n === 1) {
        await firstJobDone
      }
    })

    queue.start()
    queue.enqueue('test-job', { n: 1 })
    queue.enqueue('test-job', { n: 2 }, { priority: 'low' })

    await new Promise((resolve) => setTimeout(resolve, 20))
    queue.enqueue('test-job', { n: 3 }, { priority: 'high' })
    releaseFirst()

    await new Promise((resolve) => setTimeout(resolve, 120))
    queue.stop()

    assert.deepEqual(results, [1, 3, 2])
  })

  test('enqueueAndWait resolves after the queued job completes', async () => {
    const queue = createMemoryQueue(0)
    const results: number[] = []

    queue.register('test-job', async (job) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      results.push((job.data as { n: number }).n)
    })

    queue.start()
    await queue.enqueueAndWait('test-job', { n: 7 }, { priority: 'high' })
    queue.stop()

    assert.deepEqual(results, [7])
  })

  test('includes job data in retry warning logs', async () => {
    const queue = createMemoryQueue(0)
    const warnings: Array<{ object: Record<string, unknown>; message: string }> = []

    log.warn = ((object: Record<string, unknown>, message: string) => {
      warnings.push({ object, message })
    }) as typeof log.warn

    queue.register('generate-description', async () => {
      throw Object.assign(new Error('bad request'), { status: 400 })
    })

    queue.start()
    queue.enqueue('generate-description', { mediaId: 827 })

    await new Promise((resolve) => setTimeout(resolve, 100))
    queue.stop()

    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]?.message, '任务失败，稍后重试')
    assert.equal(warnings[0]?.object.mediaId, 827)
  })
})
