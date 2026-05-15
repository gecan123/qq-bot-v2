import { prisma } from './client.js'
import { createLogger } from '../logger.js'

const log = createLogger('RETENTION')

/**
 * 删除 7 天前零点之前的 Message 和 Media 行。
 * 启动时调用一次，释放存储空间。
 */
export async function purgeOldData(): Promise<void> {
  const now = new Date()
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)

  const { count: mediaCount } = await prisma.media.deleteMany({
    where: { createdAt: { lt: cutoff } },
  })
  const { count: messageCount } = await prisma.message.deleteMany({
    where: { createdAt: { lt: cutoff } },
  })

  log.info(
    { cutoff: cutoff.toISOString(), deletedMessages: messageCount, deletedMedia: mediaCount },
    '过期数据清理完成',
  )
}
