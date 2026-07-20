import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { ToolResultContentBlock } from '../agent-context.types.js'
import type { BackgroundTaskRegistry } from '../background-task-registry.js'
import { createToolResultProgressTracker } from '../tool-progress.js'

const argsSchema = z.object({
  taskId: z.string().min(1).describe('要查看结果的后台任务 ID.'),
})

type Args = z.infer<typeof argsSchema>

export const TASK_RESULT_TEXT_CAP_CHARS = 6000
export const TASK_RESULT_FIELD_PREVIEW_CHARS = 1000
export const TASK_RESULT_LONG_FIELD_PREVIEW_CHARS = 4000
export const TASK_RESULT_CONTEXT_IMAGE_MAX_BASE64_CHARS = 1_000_000

export interface GetTaskResultDeps {
  taskRegistry: BackgroundTaskRegistry
}

export function createGetTaskResultTool(deps: GetTaskResultDeps): Tool<Args> {
  const progressTracker = createToolResultProgressTracker()

  return {
    name: 'get_task_result',
    description: [
      '获取已完成后台任务的详细结果.',
      '对于图片生成任务, 返回结果中包含图片预览 (压缩图) 和 ephemeralRef (可传给 send_message 发送原图).',
      '任务必须已完成 (completed/failed), 否则返回错误.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = rawArgs as Args
      const task = deps.taskRegistry.get(args.taskId)

      if (!task) {
        return {
          content: JSON.stringify({ ok: false, error: `任务 #${args.taskId} 不存在` }),
          outcome: { ok: false, code: 'not_found', progress: false, retryClass: 'terminal' },
        }
      }

      if (task.status === 'running') {
        const elapsedMs = Date.now() - task.startedAt.getTime()
        return {
          content: JSON.stringify({
            ok: false,
            error: `任务 #${args.taskId} 仍在运行中 (已耗时 ${Math.round(elapsedMs / 1000)}s)`,
          }),
          outcome: { ok: true, code: 'still_running', progress: false, retryClass: 'after_event' },
        }
      }

      if (task.status !== 'completed') {
        return {
          content: stringifyCappedTaskPayload({
            ok: false,
            taskId: task.id,
            toolName: task.toolName,
            status: task.status,
            error: task.error,
            ...(task.recovery ? { recovery: task.recovery } : {}),
          }),
          outcome: { ok: false, code: task.status, progress: false, retryClass: 'terminal' },
        }
      }

      const data = task.resultData as Record<string, unknown> | undefined
      const next = nextStepForTaskResult(data)
      const ephemeralResultExpired = task.restoredFromDisk
        && (typeof data?.ephemeralRef === 'string' || Array.isArray(data?.images))
      const blocks: ToolResultContentBlock[] = [
        {
          type: 'text',
          text: stringifyCappedTaskPayload({
            ok: true,
            taskId: task.id,
            toolName: task.toolName,
            status: 'completed',
            summary: task.resultSummary,
            ...(!ephemeralResultExpired && data?.ephemeralRef != null ? { ephemeralRef: data.ephemeralRef } : {}),
            ...(data?.dataHash != null ? { dataHash: data.dataHash } : {}),
            ...(data?.byteSize != null ? { byteSize: data.byteSize } : {}),
            ...(data?.contentType != null ? { contentType: data.contentType } : {}),
            ...(data?.description != null ? { description: data.description } : {}),
            ...(data?.partialSuccess != null ? { partialSuccess: data.partialSuccess } : {}),
            ...(data?.requestedCount != null ? { requestedCount: data.requestedCount } : {}),
            ...(data?.succeededCount != null ? { succeededCount: data.succeededCount } : {}),
            ...(data?.failedCount != null ? { failedCount: data.failedCount } : {}),
            ...(!ephemeralResultExpired && Array.isArray(data?.images) ? { images: data.images } : {}),
            ...(Array.isArray(data?.failures) ? { failures: data.failures } : {}),
            ...(data?.sessionId != null ? { sessionId: data.sessionId } : {}),
            ...(data?.attemptId != null ? { attemptId: data.attemptId } : {}),
            ...(data?.result != null ? { result: data.result } : {}),
            ...(data?.truncated != null ? { truncated: data.truncated } : {}),
            ...(data?.runId != null ? { runId: data.runId } : {}),
            ...(data?.metrics != null ? { metrics: data.metrics } : {}),
            ...(ephemeralResultExpired ? {
              ephemeralResultExpired: true,
              next: '进程重启后 ephemeralRef 已失效；请重新生成图片。',
            } : next ? { next } : {}),
          }),
        },
      ]

      if (data?.contextImage && typeof data.contextImage === 'object') {
        const img = data.contextImage as { base64?: string; mediaType?: string }
        if (img.base64 && img.mediaType && img.base64.length <= TASK_RESULT_CONTEXT_IMAGE_MAX_BASE64_CHARS) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: img.base64,
            },
          })
        }
      }

      const changed = progressTracker.observe(
        task.id,
        `${task.status}:${task.updatedAt.toISOString()}:${task.resultSummary ?? ''}`,
      )
      return {
        content: blocks,
        outcome: {
          ok: true,
          code: changed ? 'completed' : 'unchanged',
          progress: changed,
          ...(changed ? {
            shareCandidate: {
              key: `background-task:${task.id}:${task.updatedAt.toISOString()}`,
              cooldownKey: `background-task:${task.toolName}`,
              summary: `后台任务“${task.description}”已完成${task.resultSummary ? `：${task.resultSummary}` : '。'}`,
            },
          } : {}),
        },
      }
    },
  }
}

function nextStepForTaskResult(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null
  if (typeof data.ephemeralRef === 'string') {
    return `发图: 调用 send_message imageRef=ephemeral:${data.ephemeralRef}`
  }
  if (Array.isArray(data.images)) {
    const first = data.images.find((image): image is { ephemeralRef: string } => (
      !!image
      && typeof image === 'object'
      && typeof (image as { ephemeralRef?: unknown }).ephemeralRef === 'string'
    ))
    if (first) return `发图: 选择 images[].ephemeralRef 后调用 send_message imageRef=ephemeral:${first.ephemeralRef}`
  }
  return null
}

function stringifyCappedTaskPayload(payload: Record<string, unknown>): string {
  const json = safeStringify(payload)
  if (json && json.length <= TASK_RESULT_TEXT_CAP_CHARS) return json

  const fallback: Record<string, unknown> = {
    ok: payload.ok,
    taskId: payload.taskId,
    toolName: payload.toolName,
    status: payload.status,
    truncated: true,
  }

  if (typeof payload.summary === 'string') {
    fallback.summary = truncateString(payload.summary, TASK_RESULT_FIELD_PREVIEW_CHARS)
  }
  if (typeof payload.error === 'string') {
    fallback.error = truncateString(payload.error, TASK_RESULT_FIELD_PREVIEW_CHARS)
  }
  if (typeof payload.result === 'string') {
    fallback.result = truncateString(payload.result, TASK_RESULT_LONG_FIELD_PREVIEW_CHARS)
  }
  for (const field of ['sessionId', 'attemptId', 'runId'] as const) {
    if (typeof payload[field] === 'string') fallback[field] = payload[field]
  }
  if (typeof payload.next === 'string') {
    fallback.next = payload.next
  }

  const fallbackJson = safeStringify(fallback)
  if (fallbackJson && fallbackJson.length <= TASK_RESULT_TEXT_CAP_CHARS) return fallbackJson

  return JSON.stringify({
    ok: payload.ok,
    taskId: payload.taskId,
    toolName: payload.toolName,
    status: payload.status,
    truncated: true,
  })
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`
}
