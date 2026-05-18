import { createLogger } from '../logger.js'

const log = createLogger('BG_TASK')

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface BackgroundTask {
  readonly id: string
  readonly toolName: string
  readonly description: string
  readonly startedAt: Date
  completedAt?: Date
  status: 'running' | 'completed' | 'failed'
  resultSummary?: string
  resultData?: JsonValue
  error?: string
}

export interface BackgroundTaskRegistry {
  register(opts: { toolName: string; description: string }): BackgroundTask
  complete(id: string, result: { summary: string; data?: JsonValue }): void
  fail(id: string, error: string): void
  get(id: string): BackgroundTask | undefined
  listRunning(): BackgroundTask[]
  listRecent(): BackgroundTask[]
}

let nextId = 1

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000
const COMPLETED_TTL_MS = 60 * 60 * 1000

export function createInMemoryTaskRegistry(): BackgroundTaskRegistry {
  const tasks = new Map<string, BackgroundTask>()
  let lastCleanup = Date.now()

  function maybeCleanup(): void {
    const now = Date.now()
    if (now - lastCleanup < CLEANUP_INTERVAL_MS) return
    lastCleanup = now
    let removed = 0
    for (const [id, task] of tasks) {
      if (task.status === 'running') continue
      if (task.completedAt && now - task.completedAt.getTime() > COMPLETED_TTL_MS) {
        tasks.delete(id)
        removed++
      }
    }
    if (removed > 0) {
      log.info({ removed, remaining: tasks.size }, 'stale_tasks_cleaned')
    }
  }

  return {
    register(opts) {
      maybeCleanup()
      const id = String(nextId++)
      const task: BackgroundTask = {
        id,
        toolName: opts.toolName,
        description: opts.description,
        startedAt: new Date(),
        status: 'running',
      }
      tasks.set(id, task)
      log.info({ taskId: id, toolName: opts.toolName, description: opts.description }, 'task_registered')
      return task
    },

    complete(id, result) {
      const task = tasks.get(id)
      if (!task) {
        log.warn({ taskId: id }, 'complete_called_for_unknown_task')
        return
      }
      task.status = 'completed'
      task.completedAt = new Date()
      task.resultSummary = result.summary
      task.resultData = result.data
      log.info(
        { taskId: id, toolName: task.toolName, elapsedMs: task.completedAt.getTime() - task.startedAt.getTime() },
        'task_completed',
      )
    },

    fail(id, error) {
      const task = tasks.get(id)
      if (!task) {
        log.warn({ taskId: id }, 'fail_called_for_unknown_task')
        return
      }
      task.status = 'failed'
      task.completedAt = new Date()
      task.error = error
      log.error(
        { taskId: id, toolName: task.toolName, error, elapsedMs: task.completedAt.getTime() - task.startedAt.getTime() },
        'task_failed',
      )
    },

    get(id) {
      return tasks.get(id)
    },

    listRunning() {
      return [...tasks.values()].filter((t) => t.status === 'running')
    },

    listRecent() {
      maybeCleanup()
      return [...tasks.values()]
        .filter((t) => t.status !== 'running')
        .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
        .slice(0, 20)
    },
  }
}
