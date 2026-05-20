import type { AgentContext } from './agent-context.js'
import { prisma } from '../database/client.js'
import { createLogger } from '../logger.js'

const log = createLogger('STICKER_POOL')

export const STICKER_POOL_PREFIX = '[你的表情包]'

export async function renderStickerPoolSummary(): Promise<string | null> {
  const stickers = await prisma.stickerPool.findMany({
    orderBy: [{ useCount: 'desc' }, { createdAt: 'desc' }],
    select: {
      mediaId: true,
      name: true,
      tags: true,
      description: true,
    },
  })

  if (stickers.length === 0) return null

  const header = `${STICKER_POOL_PREFIX} 共 ${stickers.length} 个`
  const entries = stickers.map((s) => {
    const tagsStr = s.tags.join(' ')
    return `#${s.mediaId} ${s.name} | ${tagsStr}\n${s.description}`
  })

  return header + '\n\n' + entries.join('\n\n')
}

export async function injectStickerPoolAfterCompaction(context: AgentContext): Promise<void> {
  const summary = await renderStickerPoolSummary()
  if (!summary) return
  context.appendUserMessage(summary)
  log.info({ length: summary.length }, 'sticker_pool_injected')
}
