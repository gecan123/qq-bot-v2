import { prisma } from './client.js'
import { createLogger } from '../logger.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

const log = createLogger('RETENTION')

export interface RetentionStore {
  listProtectedMediaIds(): Promise<number[]>
  deleteMessagesBefore(cutoff: Date): Promise<number>
  deleteMediaBefore(cutoff: Date, protectedIds: number[]): Promise<number>
}

const prismaRetentionStore: RetentionStore = {
  async listProtectedMediaIds() {
    const rows = await prisma.stickerPool.findMany({ select: { mediaId: true } })
    return rows.map((row) => row.mediaId)
  },
  async deleteMessagesBefore(cutoff) {
    const result = await prisma.message.deleteMany({ where: { createdAt: { lt: cutoff } } })
    return result.count
  },
  async deleteMediaBefore(cutoff, protectedIds) {
    const result = await prisma.media.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        mediaId: { notIn: protectedIds },
      },
    })
    return result.count
  },
}

/**
 * 删除 7 天前零点之前的 Message 和 Media 行。
 * 启动时调用一次，释放存储空间。
 */
export async function purgeOldData(options: {
  now?: () => Date
  store?: RetentionStore
} = {}): Promise<void> {
  const now = options.now?.() ?? new Date()
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
  const store = options.store ?? prismaRetentionStore

  const protectedIds = await store.listProtectedMediaIds()
  // 大 backlog 下，Prisma batch transaction 会受默认 5 秒事务 timeout 限制，
  // 即使 DELETE 已执行完也可能在 commit 时 P2028。两类 retention 数据没有跨表
  // 原子性要求，按顺序使用各自的隐式事务即可保持清理语义并避免启动被拖死。
  const messageCount = await store.deleteMessagesBefore(cutoff)
  const mediaCount = await store.deleteMediaBefore(cutoff, protectedIds)

  log.info(
    { cutoff: formatBeijingIso(cutoff), deletedMessages: messageCount, deletedMedia: mediaCount },
    '过期数据清理完成',
  )
}
