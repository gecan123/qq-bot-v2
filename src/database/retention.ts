import { prisma } from './client.js'
import { createLogger } from '../logger.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

const log = createLogger('RETENTION')
const ORPHAN_BLOB_GRACE_MS = 60 * 60 * 1_000
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1_000

export interface RetentionStore {
  listProtectedMediaIds(): Promise<number[]>
  deleteMessagesBefore(cutoff: Date): Promise<number>
  deleteMediaBefore(cutoff: Date, protectedIds: number[]): Promise<number>
  deleteOrphanBlobsBefore(cutoff: Date): Promise<number>
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
  async deleteOrphanBlobsBefore(cutoff) {
    const result = await prisma.mediaBlob.deleteMany({
      where: {
        touchedAt: { lt: cutoff },
        media: { none: {} },
      },
    })
    return result.count
  },
}

/**
 * 删除配置保留窗口之前的 Message / Media，再回收无人引用的旧 Blob。
 * 由 retention runner 在启动后异步执行，并于每天北京时间 03:00 重复。
 */
export async function purgeOldData(options: {
  now?: () => Date
  retentionDays?: number
  store?: RetentionStore
} = {}): Promise<void> {
  const now = options.now?.() ?? new Date()
  const retentionDays = options.retentionDays ?? 7
  const cutoff = beijingStartOfDayDaysAgo(now, retentionDays)
  const orphanBlobCutoff = new Date(now.getTime() - ORPHAN_BLOB_GRACE_MS)
  const store = options.store ?? prismaRetentionStore

  const protectedIds = await store.listProtectedMediaIds()
  // 大 backlog 下，Prisma batch transaction 会受默认 5 秒事务 timeout 限制，
  // 即使 DELETE 已执行完也可能在 commit 时 P2028。三类 retention 数据没有跨表
  // 原子性要求，按顺序使用各自的隐式事务即可保持清理语义并限制事务边界。
  const messageCount = await store.deleteMessagesBefore(cutoff)
  const mediaCount = await store.deleteMediaBefore(cutoff, protectedIds)
  const blobCount = await store.deleteOrphanBlobsBefore(orphanBlobCutoff)

  log.info(
    {
      cutoff: formatBeijingIso(cutoff),
      deletedMessages: messageCount,
      deletedMedia: mediaCount,
      deletedMediaBlobs: blobCount,
    },
    '过期数据清理完成',
  )
}

export function beijingStartOfDayDaysAgo(now: Date, daysAgo: number): Date {
  if (!Number.isInteger(daysAgo) || daysAgo < 0) {
    throw new Error(`invalid retention days: ${daysAgo}`)
  }
  const beijingNow = new Date(now.getTime() + BEIJING_OFFSET_MS)
  return new Date(Date.UTC(
    beijingNow.getUTCFullYear(),
    beijingNow.getUTCMonth(),
    beijingNow.getUTCDate() - daysAgo,
  ) - BEIJING_OFFSET_MS)
}
