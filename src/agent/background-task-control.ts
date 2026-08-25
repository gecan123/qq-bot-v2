import {
  BackgroundTaskAdmissionError,
  type BackgroundTask,
  type BackgroundTaskRegistry,
} from './background-task-registry.js'
import type { ToolExecutionOutcome, ToolExecutionResult } from './tool.js'

const CONTINUATION_DETAIL_MAX_CHARS = 1_000

export function tryRegisterBackgroundTask(
  registry: BackgroundTaskRegistry,
  input: { toolName: string; description: string },
): { ok: true; task: BackgroundTask } | { ok: false; result: ToolExecutionResult } {
  try {
    return { ok: true, task: registry.register(input) }
  } catch (error) {
    if (!(error instanceof BackgroundTaskAdmissionError)) throw error
    const message = `后台任务已达到上限（${error.active}/${error.limit}），请等待已有任务完成后再试。`
    return {
      ok: false,
      result: {
        content: JSON.stringify({
          ok: false,
          code: error.code,
          error: message,
          active: error.active,
          limit: error.limit,
          retryable: true,
          instruction: '等待 background_task_completed 通知，或用 background_task list/get 检查已有任务后重试。',
        }),
        outcome: {
          ok: false,
          code: error.code,
          error: message,
          progress: false,
          continuation: 'wait_event',
          continuationDetail: message,
          noveltyKey: `background-task-limit:${error.active}:${error.limit}`,
        },
      },
    }
  }
}

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
