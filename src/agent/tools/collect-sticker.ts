import { z } from 'zod'
import type { Tool } from '../tool.js'
import { imageHandleSchema, type ImageHandle } from '../../media/image-handle-schema.js'
import { resolveImageHandle, releaseHandle } from '../../media/image-handle.js'
import { promoteToMedia } from '../../media/promote-outbound.js'
import { prisma } from '../../database/client.js'
import { renderStickerPoolSummary } from '../sticker-pool.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_COLLECT_STICKER')

const argsSchema = z.object({
  image: imageHandleSchema.describe(
    '要收藏的图片. {mediaId:N} 走存量, {ephemeralRef:"<hash>"} 走刚收到/生成的 (1h 内有效, 会自动持久化).',
  ),
  name: z
    .string()
    .min(1)
    .max(50)
    .describe('给这个表情起个名字, 简短好记. ≤50 字.'),
  tags: z
    .array(z.string().min(1).max(20))
    .min(1)
    .max(10)
    .describe('标签数组, 1-10 个, 每个 ≤20 字. 用来按心情/场景分类, 例: ["摆烂","无语","累了"].'),
  description: z
    .string()
    .max(200)
    .optional()
    .describe('可选: 描述画面内容 + 适用场景, ≤200 字. 不传则自动取 Media 表里的图片描述.'),
})

type Args = z.infer<typeof argsSchema>

function extractDescription(raw: unknown): string {
  if (raw && typeof raw === 'object' && 'description' in raw) {
    return String((raw as Record<string, unknown>).description)
  }
  return ''
}

export const collectStickerTool: Tool<Args> = {
  name: 'collect_sticker',
  description: [
    '收藏一张已有的图片到你的表情包池 — 最常见场景: 群里有人发了好玩的表情, 你想以后也能用, 就传它的 mediaId 收进来.',
    '图片必须已经存在 (群友发过的图、你之前 generate_image / download_image 过的图). 不要为了收藏而去 generate_image 重新画一张 — 那是「创作」不是「收藏」.',
    'image 字段: 群聊消息里看到的图片描述旁会标注 mediaId, 直接传 {mediaId:N}; 刚生成/下载的图也可以传 {ephemeralRef}.',
    '每次 collect 后会返回你当前完整的表情包列表. compaction 后列表也会自动注入 context.',
    '同一张图再次 collect 会更新名字/标签/描述. description 可选, 不传自动用图片已有的描述.',
  ].join(' '),
  schema: argsSchema,
  async execute(args) {
    const handle = args.image as ImageHandle
    let mediaId: number
    let autoDescription = ''

    try {
      if ('mediaId' in handle) {
        const media = await prisma.media.findUnique({
          where: { mediaId: handle.mediaId },
          select: { mediaId: true, descriptionRaw: true },
        })
        if (!media) {
          return { content: JSON.stringify({ ok: false, error: `Media not found: mediaId=${handle.mediaId}` }) }
        }
        mediaId = handle.mediaId
        autoDescription = extractDescription(media.descriptionRaw)
      } else {
        const resolved = await resolveImageHandle(handle, { acquire: true })
        try {
          mediaId = await promoteToMedia({
            bytes: resolved.bytes,
            dataHash: resolved.dataHash,
            contentType: resolved.contentType,
            description: resolved.description,
          })
        } finally {
          releaseHandle(handle)
        }
        autoDescription = resolved.description
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn({ handle, error: message }, 'collect_sticker_resolve_failed')
      return { content: JSON.stringify({ ok: false, error: `image resolve failed: ${message}` }) }
    }

    const description = args.description?.trim() || autoDescription || '(无描述)'

    const row = await prisma.stickerPool.upsert({
      where: { mediaId },
      create: {
        mediaId,
        name: args.name,
        tags: args.tags,
        description,
      },
      update: {
        name: args.name,
        tags: args.tags,
        description,
      },
      select: { id: true },
    })

    log.info(
      {
        stickerId: row.id,
        mediaId,
        name: args.name,
        tagCount: args.tags.length,
        descriptionLength: description.length,
        autoFilled: !args.description,
      },
      'sticker_collected',
    )

    const pool = await renderStickerPoolSummary()
    const result = { ok: true, stickerId: row.id, mediaId }

    return { content: pool ? `${JSON.stringify(result)}\n\n${pool}` : JSON.stringify(result) }
  },
}
