import type { BackgroundTask } from './background-task-registry.js'
import type { ToolExecutionOutcome } from './tool.js'

const CONTINUATION_DETAIL_MAX_CHARS = 1_000

export function createBackgroundTaskWaitOutcome(input: {
  task: Pick<BackgroundTask, 'id' | 'description'>
  code: 'started' | 'still_running'
  progress: boolean
}): ToolExecutionOutcome {
  return {
    ok: true,
    code: input.code,
    progress: input.progress,
    continuation: 'wait_event',
    continuationDetail: clip(
      `后台任务“${input.task.description}”正在运行，等待完成通知`,
      CONTINUATION_DETAIL_MAX_CHARS,
    ),
    noveltyKey: `background-task:${input.task.id}:running`,
  }
}

export function createBackgroundTaskListWaitOutcome(input: {
  taskIds: readonly string[]
  progress: boolean
  code: 'observed' | 'unchanged'
}): ToolExecutionOutcome {
  const sortedTaskIds = [...input.taskIds].sort()
  return {
    ok: true,
    code: input.code,
    progress: input.progress,
    continuation: 'wait_event',
    continuationDetail: `仍有 ${sortedTaskIds.length} 个后台任务在运行，等待完成通知`,
    noveltyKey: `background-tasks:${sortedTaskIds.join(',')}:running`,
  }
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`
}
