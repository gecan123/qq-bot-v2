export interface TaskLaneConfig {
  concurrency: number
}

export interface ScheduleTaskOptions {
  lane: string
  /** 同一资源键上的任务不会并行，即使它们位于不同 lane。 */
  resourceKey?: string
  /** 相同 dedupeKey 的 queued/running 任务共享同一个 Promise。 */
  dedupeKey?: string
}

export interface TaskScheduler {
  schedule<T>(options: ScheduleTaskOptions, task: () => Promise<T>): Promise<T>
  drain(): Promise<void>
}

export const AGENT_TASK_LANES = {
  maintenance: { concurrency: 1 },
  network: { concurrency: 3 },
  'media-description': { concurrency: 2 },
  delegate: { concurrency: 2 },
} as const

export function createAgentTaskScheduler(): TaskScheduler {
  return createTaskScheduler(AGENT_TASK_LANES)
}

interface ScheduledJob {
  options: ScheduleTaskOptions
  task: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

interface LaneState {
  concurrency: number
  active: number
  queue: ScheduledJob[]
}

export function createTaskScheduler(config: Record<string, TaskLaneConfig>): TaskScheduler {
  const lanes = new Map<string, LaneState>()
  for (const [name, lane] of Object.entries(config)) {
    const concurrency = Math.floor(lane.concurrency)
    if (!name || !Number.isFinite(concurrency) || concurrency < 1) {
      throw new Error(`Invalid task lane config: ${name || '[empty]'}`)
    }
    lanes.set(name, { concurrency, active: 0, queue: [] })
  }

  const activeResources = new Set<string>()
  const deduped = new Map<string, Promise<unknown>>()
  const drainWaiters: Array<() => void> = []

  function isIdle(): boolean {
    for (const lane of lanes.values()) {
      if (lane.active > 0 || lane.queue.length > 0) return false
    }
    return true
  }

  function resolveDrainWaitersIfIdle(): void {
    if (!isIdle()) return
    for (const resolve of drainWaiters.splice(0)) resolve()
  }

  function pumpAll(): void {
    for (const lane of lanes.values()) pumpLane(lane)
    resolveDrainWaitersIfIdle()
  }

  function pumpLane(lane: LaneState): void {
    while (lane.active < lane.concurrency) {
      const index = lane.queue.findIndex((job) => (
        !job.options.resourceKey || !activeResources.has(job.options.resourceKey)
      ))
      if (index < 0) return

      const [job] = lane.queue.splice(index, 1)
      if (!job) return
      lane.active++
      if (job.options.resourceKey) activeResources.add(job.options.resourceKey)

      void job.task()
        .then(job.resolve, job.reject)
        .finally(() => {
          lane.active--
          if (job.options.resourceKey) activeResources.delete(job.options.resourceKey)
          if (job.options.dedupeKey) deduped.delete(job.options.dedupeKey)
          pumpAll()
        })
    }
  }

  return {
    schedule<T>(options: ScheduleTaskOptions, task: () => Promise<T>): Promise<T> {
      const lane = lanes.get(options.lane)
      if (!lane) return Promise.reject(new Error(`Unknown task lane: ${options.lane}`))

      if (options.dedupeKey) {
        const existing = deduped.get(options.dedupeKey)
        if (existing) return existing as Promise<T>
      }

      let resolve!: (value: T) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
      lane.queue.push({
        options,
        task,
        resolve: (value) => resolve(value as T),
        reject,
      })
      if (options.dedupeKey) deduped.set(options.dedupeKey, promise)
      pumpAll()
      return promise
    },

    async drain(): Promise<void> {
      if (isIdle()) return
      return new Promise((resolve) => drainWaiters.push(resolve))
    },
  }
}
