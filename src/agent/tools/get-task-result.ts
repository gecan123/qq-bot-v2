import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { ToolResultContentBlock } from '../agent-context.types.js'
import type { BackgroundTaskRegistry } from '../background-task-registry.js'

const argsSchema = z.object({
  taskId: z.string().min(1).describe('要查看结果的后台任务 ID.'),
})

type Args = z.infer<typeof argsSchema>

export interface GetTaskResultDeps {
  taskRegistry: BackgroundTaskRegistry
}

export function createGetTaskResultTool(deps: GetTaskResultDeps): Tool<Args> {
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
        return { content: JSON.stringify({ ok: false, error: `任务 #${args.taskId} 不存在` }) }
      }

      if (task.status === 'running') {
        const elapsedMs = Date.now() - task.startedAt.getTime()
        return {
          content: JSON.stringify({
            ok: false,
            error: `任务 #${args.taskId} 仍在运行中 (已耗时 ${Math.round(elapsedMs / 1000)}s)`,
          }),
        }
      }

      if (task.status === 'failed') {
        return {
          content: JSON.stringify({
            ok: false,
            taskId: task.id,
            toolName: task.toolName,
            status: 'failed',
            error: task.error,
          }),
        }
      }

      const data = task.resultData as Record<string, unknown> | undefined
      const blocks: ToolResultContentBlock[] = [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            taskId: task.id,
            toolName: task.toolName,
            status: 'completed',
            summary: task.resultSummary,
            ...(data?.ephemeralRef != null ? { ephemeralRef: data.ephemeralRef } : {}),
            ...(data?.dataHash != null ? { dataHash: data.dataHash } : {}),
            ...(data?.byteSize != null ? { byteSize: data.byteSize } : {}),
            ...(data?.contentType != null ? { contentType: data.contentType } : {}),
            ...(data?.description != null ? { description: data.description } : {}),
            ...(Array.isArray(data?.images) ? { images: data.images } : {}),
            ...(Array.isArray(data?.failures) ? { failures: data.failures } : {}),
          }),
        },
      ]

      if (data?.contextImage && typeof data.contextImage === 'object') {
        const img = data.contextImage as { base64?: string; mediaType?: string }
        if (img.base64 && img.mediaType) {
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

      return { content: blocks }
    },
  }
}
