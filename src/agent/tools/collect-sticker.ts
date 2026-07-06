import { z } from 'zod'
import type { Tool } from '../tool.js'
import { imageHandleSchema, type ImageHandle } from '../../media/image-handle-schema.js'
import { resolveImageHandle, releaseHandle } from '../../media/image-handle.js'
import { promoteToMedia } from '../../media/promote-outbound.js'
import { prisma } from '../../database/client.js'
import { createStickerPoolPayload, loadStickerPoolPayload } from '../sticker-pool.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_COLLECT_STICKER')

const collectArgsSchema = z.object({
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

const listArgsSchema = z.object({
  action: z.literal('list').describe('按使用次数和创建时间列出表情包.'),
  limit: z.number().int().min(1).optional().describe('最多返回多少个, 运行时上限 20.'),
})

const searchArgsSchema = z.object({
  action: z.literal('search').describe('按名称、标签或描述搜索表情包.'),
  query: z.string().min(1).max(50).describe('搜索关键词.'),
  limit: z.number().int().min(1).optional().describe('最多返回多少个, 运行时上限 20.'),
})

const randomArgsSchema = z.object({
  action: z.literal('random').describe('随机返回若干个候选表情包.'),
  tag: z.string().min(1).max(20).optional().describe('可选: 只从这个标签里随机.'),
  limit: z.number().int().min(1).optional().describe('最多返回多少个, 运行时上限 20.'),
})

const argsSchema = z.discriminatedUnion('action', [
  collectArgsSchema.extend({ action: z.literal('collect').describe('收藏或更新一张表情包.') }),
  listArgsSchema,
  searchArgsSchema,
  randomArgsSchema,
])

type Args = z.infer<typeof argsSchema>

type StickerRow = {
  id: number
  mediaId: number
  name: string
  tags: string[]
  description: string
  useCount: number
  createdAt: Date
}

const stickerSelect = {
  id: true,
  mediaId: true,
  name: true,
  tags: true,
  description: true,
  useCount: true,
  createdAt: true,
} as const

function boundedLimit(limit: number | undefined): number {
  if (limit == null) return 10
  return Math.min(limit, 20)
}

function pickRandomRows(rows: StickerRow[], limit: number): StickerRow[] {
  return [...rows]
    .sort(() => Math.random() - 0.5)
    .slice(0, limit)
}

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
    'action 必填: collect / list / search / random. 返回单个结构化 JSON 对象.',
    '图片必须已经存在 (群友发过的图、你之前 generate_image / workspace_bash `fetch image` 过的图). 不要为了收藏而去 generate_image 重新画一张 — 那是「创作」不是「收藏」.',
    'image 字段: 群聊消息里看到的图片描述旁会标注 mediaId, 直接传 {mediaId:N}; 刚生成/下载的图也可以传 {ephemeralRef}.',
    '每次 collect 后会返回你当前表情包池摘要. compaction 后摘要也会自动注入 context; 需要更多候选时用 action=list/search/random 按需查.',
    '同一张图再次 collect 会更新名字/标签/描述. description 可选, 不传自动用图片已有的描述.',
  ].join(' '),
  schema: argsSchema,
  async execute(rawArgs) {
    const args = argsSchema.parse(rawArgs)

    if (args.action === 'list') {
      const rows = await prisma.stickerPool.findMany({
        where: undefined,
        orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
        take: boundedLimit(args.limit) + 1,
        select: stickerSelect,
      })
      return {
        content: JSON.stringify({
          ok: true,
          action: 'list',
          pool: createStickerPoolPayload(rows, { limit: boundedLimit(args.limit) }),
        }),
        outcome: { ok: true },
      }
    }

    if (args.action === 'search') {
      const rows = await prisma.stickerPool.findMany({
        where: {
          OR: [
            { name: { contains: args.query, mode: 'insensitive' as const } },
            { description: { contains: args.query, mode: 'insensitive' as const } },
            { tags: { has: args.query } },
          ],
        },
        orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
        take: boundedLimit(args.limit) + 1,
        select: stickerSelect,
      })
      return {
        content: JSON.stringify({
          ok: true,
          action: 'search',
          query: args.query,
          pool: createStickerPoolPayload(rows, { limit: boundedLimit(args.limit) }),
        }),
        outcome: { ok: true },
      }
    }

    if (args.action === 'random') {
      const limit = boundedLimit(args.limit)
      const rows = await prisma.stickerPool.findMany({
        where: args.tag ? { tags: { has: args.tag } } : undefined,
        orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
        take: 20,
        select: stickerSelect,
      })
      return {
        content: JSON.stringify({
          ok: true,
          action: 'random',
          pool: createStickerPoolPayload(pickRandomRows(rows, limit), {
            limit,
            truncated: rows.length > limit,
          }),
        }),
        outcome: { ok: true },
      }
    }

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
          return {
            content: JSON.stringify({
              ok: false,
              action: 'collect',
              code: 'media_not_found',
              error: `Media not found: mediaId=${handle.mediaId}`,
            }),
            outcome: { ok: false, code: 'media_not_found' },
          }
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
      return {
        content: JSON.stringify({
          ok: false,
          action: 'collect',
          code: 'image_resolve_failed',
          error: `image resolve failed: ${message}`,
        }),
        outcome: { ok: false, code: 'image_resolve_failed' },
      }
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

    const pool = await loadStickerPoolPayload() ?? { stickers: [], truncated: false }
    return {
      content: JSON.stringify({
        ok: true,
        action: 'collect',
        sticker: { stickerId: row.id, mediaId, mediaRef: `media:${mediaId}` },
        pool,
      }),
      outcome: { ok: true },
    }
  },
}
