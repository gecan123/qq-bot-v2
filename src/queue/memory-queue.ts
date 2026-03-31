import { log } from '../logger.js'
import type { Job, JobEnqueueOptions, JobHandler, JobPriority, JobQueue } from './types.js'

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 5_000
const POLL_INTERVAL_MS = 1_000

function getJobContext(data: unknown): Record<string, unknown> {
  if (data == null) return {}
  if (typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>
  }
  return { jobData: data }
}

interface JobWaiter {
  resolve: () => void
  reject: (error: unknown) => void
}

interface QueuedJob extends Job {
  waiters: JobWaiter[]
}

const PRIORITY_ORDER: Record<JobPriority, number> = {
  high: 2,
  normal: 1,
  low: 0,
}

function resolvePriority(options?: JobEnqueueOptions): JobPriority {
  return options?.priority ?? 'normal'
}

function pushByPriority(queue: QueuedJob[], job: QueuedJob) {
  const jobPriority = PRIORITY_ORDER[job.priority]
  const insertAt = queue.findIndex((queuedJob) => PRIORITY_ORDER[queuedJob.priority] < jobPriority)
  if (insertAt === -1) {
    queue.push(job)
    return
  }
  queue.splice(insertAt, 0, job)
}

export function createMemoryQueue(interJobDelayMs = 0): JobQueue {
  const queue: QueuedJob[] = []
  const handlers = new Map<string, JobHandler<string, unknown>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let processing = false

  async function tick() {
    if (!running || processing) return

    const job = queue.shift()
    if (!job) {
      schedule(POLL_INTERVAL_MS)
      return
    }

    const handler = handlers.get(job.type)
    if (!handler) {
      log.warn({ type: job.type, jobId: job.id }, '未注册的任务类型，跳过')
      for (const waiter of job.waiters) waiter.reject(new Error(`No handler registered for job type: ${job.type}`))
      job.waiters.length = 0
      schedule(0)
      return
    }

    processing = true
    job.attempts++

    try {
      await handler(job)
      for (const waiter of job.waiters) waiter.resolve()
      job.waiters.length = 0
    } catch (error) {
      if (job.attempts >= MAX_ATTEMPTS) {
        log.error(
          { ...getJobContext(job.data), jobId: job.id, type: job.type, error },
          '任务重试次数耗尽，丢弃',
        )
        for (const waiter of job.waiters) waiter.reject(error)
        job.waiters.length = 0
      } else {
        log.warn(
          { ...getJobContext(job.data), jobId: job.id, type: job.type, attempts: job.attempts, error },
          '任务失败，稍后重试',
        )
        // Move to back of queue for retry
        setTimeout(() => {
          if (running) {
            pushByPriority(queue, job)
            schedule(0)
          }
        }, RETRY_DELAY_MS)
      }
    } finally {
      processing = false
    }

    schedule(interJobDelayMs)
  }

  function schedule(delayMs: number) {
    if (!running) return
    clearTimeout(timer)
    timer = setTimeout(tick, delayMs)
  }

  let nextId = 1

  return {
    enqueue(type, data, options) {
      const job: QueuedJob = {
        id: String(nextId++),
        type,
        data,
        createdAt: Date.now(),
        attempts: 0,
        priority: resolvePriority(options),
        waiters: [],
      }
      pushByPriority(queue, job)
      log.debug({ jobId: job.id, type }, '任务已入队')
      if (running && !processing) schedule(0)
    },

    enqueueAndWait(type, data, options) {
      return new Promise<void>((resolve, reject) => {
        const job: QueuedJob = {
          id: String(nextId++),
          type,
          data,
          createdAt: Date.now(),
          attempts: 0,
          priority: resolvePriority(options),
          waiters: [{ resolve, reject }],
        }
        pushByPriority(queue, job)
        log.debug({ jobId: job.id, type }, '任务已入队')
        if (running && !processing) schedule(0)
      })
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
