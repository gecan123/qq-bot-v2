import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { BackgroundTaskRegistry } from '../background-task-registry.js'

const argsSchema = z.object({})

export interface CheckTasksDeps {
  taskRegistry: BackgroundTaskRegistry
}

export function createCheckTasksTool(deps: CheckTasksDeps): Tool<z.infer<typeof argsSchema>> {
  return {
    name: 'check_tasks',
    description: '查看后台任务的状态. 返回当前正在运行的任务和最近完成/失败的任务.',
    schema: argsSchema,
    async execute() {
      const running = deps.taskRegistry.listRunning().map((t) => ({
        taskId: t.id,
        toolName: t.toolName,
        description: t.description,
        elapsedMs: Date.now() - t.startedAt.getTime(),
      }))

      const recent = deps.taskRegistry.listRecent().map((t) => ({
        taskId: t.id,
        toolName: t.toolName,
        description: t.description,
        ok: t.status === 'completed',
        elapsedMs: t.completedAt
          ? t.completedAt.getTime() - t.startedAt.getTime()
          : Date.now() - t.startedAt.getTime(),
        summary: t.resultSummary ?? t.error ?? '',
      }))

      return {
        content: JSON.stringify({ running, recentCompleted: recent }),
      }
    },
  }
}
