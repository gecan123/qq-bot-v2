import { z } from 'zod'
import type { Tool, ToolContext } from '../tool.js'
import { imageHandleSchema, type ImageProduceResult } from '../../media/image-handle-schema.js'
import { resolveImageHandle, releaseHandle } from '../../media/image-handle.js'
import { getOutboundCache } from '../../media/outbound-cache.js'
import { computeMediaHash } from '../../media/media-hash.js'
import { compressForContext } from '../../media/compress-for-context.js'
import { generateImage, editImage } from '../../llm/image-gen.js'
import type { ImageGenerationOptions } from '../../llm/image-gen.js'
import type { BackgroundTaskRegistry, JsonValue } from '../background-task-registry.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_GENERATE_IMAGE')

const argsSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      '图片生成/编辑的英文提示词. 从零生成时尽量详细描述期望画面.' +
      ' 编辑已有图时, 根据意图选择 prompt 策略:' +
      ' (1) 微调 (改文字/加元素/调颜色等, 保持原图构图和风格不变) → prompt 必须详细描述原图的全部内容 + 你要改的部分, 否则模型会丢失原图细节;' +
      ' (2) 大改 (换风格/重构画面/只保留主体) → prompt 描述你想要的新画面即可.',
    ),
  image: imageHandleSchema
    .optional()
    .describe('可选: 要编辑的源图片. 传 {mediaId} 或 {ephemeralRef}. 不传则从零生成.'),
  images: z.array(imageHandleSchema)
    .max(5)
    .optional()
    .describe('可选: 要编辑/参考的源图片数组, 最多 5 张. 多图时请在 prompt 里说明保留主体、布局、风格和合成目标.'),
  quality: z.enum(['low', 'medium', 'high'])
    .default('low')
    .describe('图片生成质量. low 更省, high 更精细, 默认 low.'),
  count: z.number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe('生成图片数量, 1 到 4 张.'),
}).superRefine((args, ctx) => {
  if (args.image && args.images) {
    ctx.addIssue({
      code: 'custom',
      path: ['images'],
      message: 'image and images cannot both be provided',
    })
  }
})

type RawArgs = z.input<typeof argsSchema>
type Args = z.output<typeof argsSchema>

export interface GenerateImageDeps {
  generate?: (prompt: string, options?: ImageGenerationOptions) => Promise<Buffer>
  edit?: (prompt: string, source: Buffer[], options?: ImageGenerationOptions) => Promise<Buffer>
  taskRegistry: BackgroundTaskRegistry
}

export function createGenerateImageTool(deps: GenerateImageDeps): Tool<RawArgs> {
  const generate = deps.generate ?? generateImage
  const edit = deps.edit ?? editImage

  return {
    name: 'generate_image',
    description: [
      '用 AI 从零生成一张新图片, 或基于已有图片进行编辑/改图.',
      '这是「创作」工具 — 想画新东西、改图、加文字时用. 不要用来「收藏」已有的图 (收藏走 collect_sticker).',
      '只传 prompt → 从零生成; 同时传 image → 在该图基础上按 prompt 编辑.',
      '编辑图片时注意区分意图: 用户想「微调」(改文字/局部修改/保持风格) 还是「大改」(换风格/重构). 如果对方说得模糊 (比如只说「帮我改一下这图」), 先 send_message 问一句是想保持原样微调还是大改, 再动手.',
      '本工具只负责创建图片生成/编辑后台任务, 立即返回 taskId; 不直接返回最终图片. 完成后你会收到 [后台任务完成] 消息.',
      '后续统一用 background_task action=list/get 查看状态或取结果 (含预览图 + ephemeralRef, 可传给 send_message 发送).',
      'prompt 用英文效果最好.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx: ToolContext) {
      const args = argsSchema.parse(rawArgs)
      const sourceImages = args.images ?? (args.image ? [args.image] : [])

      const sourceBytes: Buffer[] = []
      try {
        for (const image of sourceImages) {
          const resolved = await resolveImageHandle(image, { acquire: true })
          sourceBytes.push(resolved.bytes)
        }
      } catch (err) {
        for (const image of sourceImages.slice(0, sourceBytes.length)) {
          releaseHandle(image)
        }
        return {
          content: JSON.stringify({
            ok: false,
            error: `源图片解析失败: ${err instanceof Error ? err.message : String(err)}`,
          }),
        }
      }

      const isEdit = sourceBytes.length > 0
      const description = isEdit
        ? `编辑图片: ${args.prompt.slice(0, 100)}`
        : `生成图片: ${args.prompt.slice(0, 100)}`

      const task = deps.taskRegistry.register({ toolName: 'generate_image', description })

      const bgWork = async () => {
        try {
          const images: ImageProduceResult[] = []
          const failures: string[] = []
          let firstCompressed: Awaited<ReturnType<typeof compressForContext>> | null = null

          for (let index = 0; index < args.count; index++) {
            try {
              const imageBytes = isEdit
                ? await edit(args.prompt, sourceBytes, { quality: args.quality })
                : await generate(args.prompt, { quality: args.quality })

              const dataHash = computeMediaHash(imageBytes)
              const imgDescription = isEdit
                ? `AI edited image ${index + 1}/${args.count}: ${args.prompt.slice(0, 200)}`
                : `AI generated image ${index + 1}/${args.count}: ${args.prompt.slice(0, 200)}`

              const cache = getOutboundCache()
              cache.put({
                bytes: imageBytes,
                dataHash,
                byteSize: imageBytes.byteLength,
                contentType: 'image/png',
                description: imgDescription,
              })

              images.push({
                ephemeralRef: dataHash,
                dataHash,
                byteSize: imageBytes.byteLength,
                contentType: 'image/png',
                description: imgDescription,
              })

              if (!firstCompressed) {
                firstCompressed = await compressForContext(imageBytes)
              }
            } catch (err) {
              failures.push(`image ${index + 1}/${args.count}: ${err instanceof Error ? err.message : String(err)}`)
            }
          }

          if (images.length === 0) {
            throw new Error(failures.join('; ') || 'all image generation attempts failed')
          }

          const firstResult = images[0]!
          const resultData: Record<string, JsonValue> = {
            ephemeralRef: firstResult.ephemeralRef,
            dataHash: firstResult.dataHash,
            byteSize: firstResult.byteSize,
            contentType: firstResult.contentType,
            description: firstResult.description,
            requestedCount: args.count,
            succeededCount: images.length,
            failedCount: failures.length,
            images: images.map((image) => ({
              ephemeralRef: image.ephemeralRef,
              dataHash: image.dataHash,
              byteSize: image.byteSize,
              contentType: image.contentType,
              description: image.description,
            })),
          }
          if (failures.length > 0) {
            resultData.partialSuccess = true
            resultData.failures = failures
          }
          if (firstCompressed) {
            resultData.contextImage = {
              base64: firstCompressed.base64,
              mediaType: firstCompressed.mediaType,
            }
          }

          const summary = args.count === 1
            ? `图片已生成 (ephemeralRef=${firstResult.ephemeralRef.slice(0, 8)}…, ${(firstResult.byteSize / 1024).toFixed(0)}KB)`
            : `图片已生成 ${images.length}/${args.count} 张 (首张 ephemeralRef=${firstResult.ephemeralRef.slice(0, 8)}…)`
          deps.taskRegistry.complete(task.id, { summary, data: resultData })

          const elapsedMs = Date.now() - task.startedAt.getTime()
          ctx.eventQueue.enqueue({
            type: 'background_task_completed',
            taskId: task.id,
            toolName: 'generate_image',
            description,
            elapsedMs,
            ok: true,
            summary,
          })
        } catch (err) {
          const errorMsg = `图片生成失败: ${err instanceof Error ? err.message : String(err)}`
          log.error({ err, taskId: task.id, hasSource: isEdit }, 'generate_image_bg_failed')
          deps.taskRegistry.fail(task.id, errorMsg)

          const elapsedMs = Date.now() - task.startedAt.getTime()
          ctx.eventQueue.enqueue({
            type: 'background_task_completed',
            taskId: task.id,
            toolName: 'generate_image',
            description,
            elapsedMs,
            ok: false,
            summary: errorMsg,
          })
        } finally {
          for (const image of sourceImages) releaseHandle(image)
        }
      }

      void bgWork()

      return {
        content: JSON.stringify({
          ok: true,
          status: 'started',
          taskId: task.id,
          description,
        }),
      }
    },
  }
}
