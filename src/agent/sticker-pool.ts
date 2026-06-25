import type { AgentContext } from './agent-context.js'
import { prisma } from '../database/client.js'
import { createLogger } from '../logger.js'

const log = createLogger('STICKER_POOL')

export const STICKER_POOL_PREFIX = '[你的表情包]'
export const STICKER_POOL_SUMMARY_LIMIT = 20
export const STICKER_POOL_DESCRIPTION_PREVIEW_CHARS = 160
export const STICKER_POOL_SUMMARY_MAX_CHARS = 4000

export async function renderStickerPoolSummary(): Promise<string | null> {
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

  const visible = stickers.slice(0, STICKER_POOL_SUMMARY_LIMIT)
  const hasMore = stickers.length > STICKER_POOL_SUMMARY_LIMIT
  const header = hasMore
    ? `${STICKER_POOL_PREFIX} 显示前 ${visible.length} 个`
    : `${STICKER_POOL_PREFIX} 共 ${visible.length} 个`
  const entries = visible.map((s) => {
    const tagsStr = s.tags.join(' ')
    return `#${s.mediaId} ${s.name} | ${tagsStr}\n${truncateText(s.description, STICKER_POOL_DESCRIPTION_PREVIEW_CHARS)}`
  })

  const footer = hasMore
    ? '\n\n还有更多表情包; 用 collect_sticker action=list/search/random 按需查看。'
    : ''

  return capSummary(header + '\n\n' + entries.join('\n\n') + footer)
}

export async function injectStickerPoolAfterCompaction(context: AgentContext): Promise<void> {
  const summary = await renderStickerPoolSummary()
  if (!summary) return
  context.appendUserMessage(summary)
  log.info({ length: summary.length }, 'sticker_pool_injected')
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`
}

function capSummary(summary: string): string {
  if (summary.length <= STICKER_POOL_SUMMARY_MAX_CHARS) return summary
  const suffix = '\n[表情包摘要已截断; 用 collect_sticker action=search 按需查。]'
  return summary.slice(0, Math.max(0, STICKER_POOL_SUMMARY_MAX_CHARS - suffix.length)) + suffix
}
