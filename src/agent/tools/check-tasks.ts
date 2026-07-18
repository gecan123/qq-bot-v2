import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { BackgroundTaskRegistry } from '../background-task-registry.js'
import { createToolResultProgressTracker } from '../tool-progress.js'

const argsSchema = z.object({})

export interface CheckTasksDeps {
  taskRegistry: BackgroundTaskRegistry
}

export function createCheckTasksTool(deps: CheckTasksDeps): Tool<z.infer<typeof argsSchema>> {
  const progressTracker = createToolResultProgressTracker()

  return {
    name: 'check_tasks',
    description: '查看后台任务的状态. 返回当前正在运行的任务和最近完成/失败的任务.',
    schema: argsSchema,
    async execute() {
      const runningTasks = deps.taskRegistry.listRunning()
      const recentTasks = deps.taskRegistry.listRecent()
      const running = runningTasks.map((t) => ({
        taskId: t.id,
        toolName: t.toolName,
        description: t.description,
        elapsedMs: Date.now() - t.startedAt.getTime(),
      }))

      const recent = recentTasks.map((t) => ({
        taskId: t.id,
        toolName: t.toolName,
        description: t.description,
        status: t.status,
        ok: t.status === 'completed',
        elapsedMs: t.completedAt
          ? t.completedAt.getTime() - t.startedAt.getTime()
          : Date.now() - t.startedAt.getTime(),
        summary: t.resultSummary ?? t.error ?? '',
      }))

      const signature = JSON.stringify({
        running: runningTasks.map((task) => [task.id, task.status, task.updatedAt.toISOString()]),
        recent: recentTasks.map((task) => [task.id, task.status, task.updatedAt.toISOString()]),
      })
      const changed = progressTracker.observe('list', signature)
      return {
        content: JSON.stringify({ running, recentCompleted: recent }),
        outcome: {
          ok: true,
          code: changed ? 'observed' : 'unchanged',
          progress: changed,
          ...(runningTasks.length > 0 ? { retryClass: 'after_event' as const } : {}),
        },
      }
    },
  }
}
