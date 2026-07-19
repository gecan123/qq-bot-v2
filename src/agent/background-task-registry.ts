import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from '../logger.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

const log = createLogger('BG_TASK')

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'

export interface BackgroundTask {
  readonly id: string
  readonly toolName: string
  readonly description: string
  readonly startedAt: Date
  updatedAt: Date
  completedAt?: Date
  status: BackgroundTaskStatus
  attempt: number
  resultSummary?: string
  resultData?: JsonValue
  error?: string
  /** 只为读取旧持久状态保留；当前 runner 不根据它恢复任务。 */
  recovery?: { kind: string; payload: JsonValue }
  /** 仅运行时标记：任务来自磁盘，未随进程持久化的 ephemeral handles 不能假定仍有效。 */
  restoredFromDisk?: boolean
}

export interface BackgroundTaskRegistry {
  register(opts: {
    toolName: string
    description: string
  }): BackgroundTask
  complete(id: string, result: { summary: string; data?: JsonValue }): void
  fail(id: string, error: string): void
  cancel(id: string, reason?: string): boolean
  get(id: string): BackgroundTask | undefined
  listRunning(): BackgroundTask[]
  listRecent(): BackgroundTask[]
}

export interface PersistentTaskRegistryResult {
  registry: BackgroundTaskRegistry
  /** 本次启动把旧 running 任务转成 interrupted 的任务，用于发布可见恢复事件。 */
  interruptedAtStartup: BackgroundTask[]
}

interface StoredBackgroundTask extends Omit<
  BackgroundTask,
  'startedAt' | 'updatedAt' | 'completedAt' | 'restoredFromDisk'
> {
  startedAt: string
  updatedAt: string
  completedAt?: string
}

interface StoredRegistryV1 {
  schemaVersion: 1
  tasks: StoredBackgroundTask[]
}

interface RegistryOptions {
  now?: () => Date
  idFactory?: () => string
  completedTtlMs?: number
  recentLimit?: number
}

interface PersistentRegistryOptions extends RegistryOptions {
  path: string
}

const DEFAULT_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_RECENT_LIMIT = 20

export function createInMemoryTaskRegistry(options: RegistryOptions = {}): BackgroundTaskRegistry {
  let nextId = 1
  return createTaskRegistry({
    ...options,
    idFactory: options.idFactory ?? (() => String(nextId++)),
    initialTasks: [],
    persist: () => {},
  }).registry
}

export function createPersistentTaskRegistry(
  options: PersistentRegistryOptions,
): PersistentTaskRegistryResult {
  const now = options.now ?? (() => new Date())
  const initialTasks = loadTasks(options.path)
  const interruptedAtStartup: BackgroundTask[] = []
  const interruptedAt = now()

  for (const task of initialTasks) {
    if (task.status !== 'running') continue
    task.status = 'interrupted'
    task.updatedAt = interruptedAt
    task.completedAt = interruptedAt
    task.error = 'process_restarted_before_completion'
    interruptedAtStartup.push(cloneTask(task))
  }

  const result = createTaskRegistry({
    ...options,
    now,
    idFactory: options.idFactory ?? (() => `bg_${randomUUID()}`),
    initialTasks,
    persist: (tasks) => persistTasks(options.path, tasks),
  })
  if (interruptedAtStartup.length > 0) {
    result.persistNow()
    log.warn(
      { path: options.path, interrupted: interruptedAtStartup.length },
      'running_tasks_marked_interrupted_after_restart',
    )
  }

  return { registry: result.registry, interruptedAtStartup }
}

function createTaskRegistry(options: RegistryOptions & {
  initialTasks: BackgroundTask[]
  persist: (tasks: readonly BackgroundTask[]) => void
}): { registry: BackgroundTaskRegistry; persistNow: () => void } {
  const tasks = new Map(options.initialTasks.map((task) => [task.id, task]))
  const now = options.now ?? (() => new Date())
  const idFactory = options.idFactory ?? randomUUID
  const completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT

  const persistNow = () => options.persist([...tasks.values()])

  function cleanup(reference = now()): boolean {
    let changed = false
    for (const [id, task] of tasks) {
      if (task.status === 'running' || !task.completedAt) continue
      if (reference.getTime() - task.completedAt.getTime() > completedTtlMs) {
        tasks.delete(id)
        changed = true
      }
    }
    return changed
  }

  function transitionTerminal(
    id: string,
    status: Exclude<BackgroundTaskStatus, 'running'>,
    update: (task: BackgroundTask) => void,
  ): boolean {
    const task = tasks.get(id)
    if (!task) {
      log.warn({ taskId: id, status }, 'terminal_transition_for_unknown_task')
      return false
    }
    if (task.status !== 'running') {
      log.warn({ taskId: id, currentStatus: task.status, requestedStatus: status }, 'terminal_transition_ignored')
      return false
    }
    const finishedAt = now()
    task.status = status
    task.updatedAt = finishedAt
    task.completedAt = finishedAt
    update(task)
    cleanup(finishedAt)
    persistNow()
    return true
  }

  const registry: BackgroundTaskRegistry = {
    register(opts) {
      const registeredAt = now()
      cleanup(registeredAt)
      let id = idFactory()
      while (tasks.has(id)) id = idFactory()
      const task: BackgroundTask = {
        id,
        toolName: opts.toolName,
        description: opts.description,
        startedAt: registeredAt,
        updatedAt: registeredAt,
        status: 'running',
        attempt: 1,
      }
      tasks.set(id, task)
      persistNow()
      log.info({ taskId: id, toolName: opts.toolName, description: opts.description }, 'task_registered')
      return cloneTask(task)
    },

    complete(id, result) {
      const changed = transitionTerminal(id, 'completed', (task) => {
        task.resultSummary = result.summary
        task.resultData = result.data === undefined ? undefined : structuredClone(result.data)
      })
      if (!changed) return
      const task = tasks.get(id)!
      log.info(
        { taskId: id, toolName: task.toolName, elapsedMs: task.completedAt!.getTime() - task.startedAt.getTime() },
        'task_completed',
      )
    },

    fail(id, error) {
      const changed = transitionTerminal(id, 'failed', (task) => {
        task.error = error
      })
      if (!changed) return
      const task = tasks.get(id)!
      log.error(
        { taskId: id, toolName: task.toolName, error, elapsedMs: task.completedAt!.getTime() - task.startedAt.getTime() },
        'task_failed',
      )
    },

    cancel(id, reason = 'cancelled_by_user') {
      return transitionTerminal(id, 'cancelled', (task) => {
        task.error = reason
      })
    },

    get(id) {
      const task = tasks.get(id)
      return task ? cloneTask(task) : undefined
    },

    listRunning() {
      return [...tasks.values()]
        .filter((task) => task.status === 'running')
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        .map(cloneTask)
    },

    listRecent() {
      if (cleanup()) persistNow()
      return [...tasks.values()]
        .filter((task) => task.status !== 'running')
        .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
        .slice(0, recentLimit)
        .map(cloneTask)
    },
  }

  return { registry, persistNow }
}

function loadTasks(path: string): BackgroundTask[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const parsed = JSON.parse(raw) as StoredRegistryV1
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) {
    throw new Error(`Unsupported background task registry schema: ${path}`)
  }
  return parsed.tasks.map((task) => {
    const { startedAt, updatedAt, completedAt, ...rest } = task
    return {
      ...rest,
      restoredFromDisk: true,
      startedAt: parseStoredDate(startedAt, path),
      updatedAt: parseStoredDate(updatedAt, path),
      ...(completedAt ? { completedAt: parseStoredDate(completedAt, path) } : {}),
    }
  })
}

function persistTasks(path: string, tasks: readonly BackgroundTask[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const payload: StoredRegistryV1 = {
    schemaVersion: 1,
    tasks: tasks.map((task) => {
      const { startedAt, updatedAt, completedAt, restoredFromDisk: _restored, ...rest } = task
      return {
        ...rest,
        startedAt: formatBeijingIso(startedAt),
        updatedAt: formatBeijingIso(updatedAt),
        ...(completedAt ? { completedAt: formatBeijingIso(completedAt) } : {}),
      }
    }),
  }
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function parseStoredDate(value: string, path: string): Date {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid task timestamp in ${path}: ${value}`)
  return date
}

function cloneTask(task: BackgroundTask): BackgroundTask {
  return structuredClone(task)
}
