import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { ToolResultContentBlock } from '../agent-context.types.js'
import { imageHandleSchema, type ImageProduceResult } from '../../media/image-handle-schema.js'
import { resolveImageHandle, releaseHandle } from '../../media/image-handle.js'
import { getOutboundCache } from '../../media/outbound-cache.js'
import { computeMediaHash } from '../../media/media-hash.js'
import { compressForContext } from '../../media/compress-for-context.js'
import { generateImage, editImage } from '../../llm/image-gen.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_GENERATE_IMAGE')

const argsSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .describe('图片生成/编辑的英文提示词. 尽量详细描述期望的画面.'),
  image: imageHandleSchema
    .optional()
    .describe('可选: 要编辑的源图片. 传 {mediaId} 或 {ephemeralRef}. 不传则从零生成.'),
})

type Args = z.infer<typeof argsSchema>

export interface GenerateImageDeps {
  generate?: (prompt: string) => Promise<Buffer>
  edit?: (prompt: string, source: Buffer) => Promise<Buffer>
}

export function createGenerateImageTool(deps: GenerateImageDeps = {}): Tool<Args> {
  const generate = deps.generate ?? generateImage
  const edit = deps.edit ?? editImage

  return {
    name: 'generate_image',
    description: [
      '用 AI 生成一张图片, 或基于已有图片进行编辑.',
      '只传 prompt → 从零生成; 同时传 image → 在该图基础上按 prompt 编辑.',
      '返回 ephemeralRef (可直接传给 send_message 的 image 字段发送).',
      'prompt 用英文效果最好.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = rawArgs as Args

      let sourceBytes: Buffer | undefined
      try {
        if (args.image) {
          const resolved = await resolveImageHandle(args.image, { acquire: true })
          sourceBytes = resolved.bytes
        }
      } catch (err) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `源图片解析失败: ${err instanceof Error ? err.message : String(err)}`,
          }),
        }
      }

      let imageBytes: Buffer
      try {
        imageBytes = sourceBytes
          ? await edit(args.prompt, sourceBytes)
          : await generate(args.prompt)
      } catch (err) {
        log.error({ err, hasSource: !!sourceBytes }, 'generate_image_failed')
        return {
          content: JSON.stringify({
            ok: false,
            error: `图片生成失败: ${err instanceof Error ? err.message : String(err)}`,
          }),
        }
      } finally {
        if (args.image) releaseHandle(args.image)
      }

      const dataHash = computeMediaHash(imageBytes)
      const description = sourceBytes
        ? `AI edited image: ${args.prompt.slice(0, 200)}`
        : `AI generated image: ${args.prompt.slice(0, 200)}`

      const cache = getOutboundCache()
      cache.put({
        bytes: imageBytes,
        dataHash,
        byteSize: imageBytes.byteLength,
        contentType: 'image/png',
        description,
      })

      const result: ImageProduceResult = {
        ephemeralRef: dataHash,
        dataHash,
        byteSize: imageBytes.byteLength,
        contentType: 'image/png',
        description,
      }

      const compressed = await compressForContext(imageBytes)
      const blocks: ToolResultContentBlock[] = [
        { type: 'text', text: JSON.stringify({ ok: true, ...result }) },
      ]
      if (compressed) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: compressed.mediaType, data: compressed.base64 },
        })
      }

      return { content: blocks }
    },
  }
}
