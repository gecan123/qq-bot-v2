import { prisma } from '../database/client.js'

export const STICKER_POOL_SUMMARY_LIMIT = 20
export const STICKER_POOL_DESCRIPTION_PREVIEW_CHARS = 160
export const STICKER_POOL_SUMMARY_MAX_CHARS = 4000

export interface StickerPoolItem {
  mediaId: number
  mediaRef: string
  name: string
  tags: string[]
  description: string
  useCount?: number
}

export interface StickerPoolPayload {
  stickers: StickerPoolItem[]
  truncated: boolean
}

interface StickerPoolSourceRow {
  mediaId: number
  name: string
  tags: string[]
  description: string
  useCount?: number
}

export function createStickerPoolPayload(
  rows: StickerPoolSourceRow[],
  options: { limit?: number; truncated?: boolean } = {},
): StickerPoolPayload {
  const limit = Math.min(options.limit ?? STICKER_POOL_SUMMARY_LIMIT, STICKER_POOL_SUMMARY_LIMIT)
  let truncated = options.truncated === true || rows.length > limit
  const stickers = rows.slice(0, limit).map((row) => {
    const name = truncateText(row.name, 50)
    const description = truncateText(row.description, STICKER_POOL_DESCRIPTION_PREVIEW_CHARS)
    const tags = row.tags.slice(0, 10).map((tag) => truncateText(tag, 20))
    if (name !== row.name || description !== row.description || tags.length !== row.tags.length
      || tags.some((tag, index) => tag !== row.tags[index])) {
      truncated = true
    }
    return {
      mediaId: row.mediaId,
      mediaRef: `media:${row.mediaId}`,
      name,
      tags,
      description,
      ...(row.useCount == null ? {} : { useCount: row.useCount }),
    }
  })

  while (
    JSON.stringify({ source: 'sticker_pool', stickers, truncated }).length > STICKER_POOL_SUMMARY_MAX_CHARS
    && stickers.length > 0
  ) {
    stickers.pop()
    truncated = true
  }
  return { stickers, truncated }
}

export async function loadStickerPoolPayload(): Promise<StickerPoolPayload | null> {
  const stickers = await prisma.stickerPool.findMany({
    orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
    take: STICKER_POOL_SUMMARY_LIMIT + 1,
    select: {
      mediaId: true,
      name: true,
      tags: true,
      description: true,
    },
  })

  if (stickers.length === 0) return null
  return createStickerPoolPayload(stickers, { limit: STICKER_POOL_SUMMARY_LIMIT })
}

export async function renderStickerPoolSummary(): Promise<string | null> {
  const payload = await loadStickerPoolPayload()
  return payload ? JSON.stringify({ source: 'sticker_pool', ...payload }) : null
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}
