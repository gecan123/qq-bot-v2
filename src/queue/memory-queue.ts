import { log } from '../logger.js'
import type { Job, JobHandler, JobQueue } from './types.js'

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 5_000
const POLL_INTERVAL_MS = 1_000

export function createMemoryQueue(): JobQueue {
  const queue: Job[] = []
  const handlers = new Map<string, JobHandler<string, unknown>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let processing = false

  async function tick() {
    if (!running || processing) return

    const job = queue[0]
    if (!job) {
      schedule(POLL_INTERVAL_MS)
      return
    }

    const handler = handlers.get(job.type)
    if (!handler) {
      log.warn({ type: job.type, jobId: job.id }, '未注册的任务类型，跳过')
      queue.shift()
      schedule(0)
      return
    }

    processing = true
    job.attempts++

    try {
      await handler(job)
      queue.shift()
    } catch (error) {
      if (job.attempts >= MAX_ATTEMPTS) {
        log.error({ jobId: job.id, type: job.type, error }, '任务重试次数耗尽，丢弃')
        queue.shift()
      } else {
        log.warn({ jobId: job.id, type: job.type, attempts: job.attempts, error }, '任务失败，稍后重试')
        // Move to back of queue for retry
        queue.shift()
        setTimeout(() => {
          if (running) {
            queue.push(job)
            schedule(0)
          }
        }, RETRY_DELAY_MS)
      }
    } finally {
      processing = false
    }

    schedule(0)
  }

  function schedule(delayMs: number) {
    if (!running) return
    clearTimeout(timer)
    timer = setTimeout(tick, delayMs)
  }

  let nextId = 1

  return {
    enqueue(type, data) {
      const job: Job = {
        id: String(nextId++),
        type,
        data,
        createdAt: Date.now(),
        attempts: 0,
      }
      queue.push(job)
      log.debug({ jobId: job.id, type }, '任务已入队')
      if (running && !processing) schedule(0)
    },

    register(type, handler) {
      handlers.set(type, handler as JobHandler<string, unknown>)
    },

    start() {
      if (running) return
      running = true
      log.info('任务队列已启动')
      schedule(0)
    },

    stop() {
      running = false
      clearTimeout(timer)
      log.info('任务队列已停止')
    },
  }
}
