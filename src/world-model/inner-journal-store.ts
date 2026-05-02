import { prisma } from '../database/client.js'
import { Prisma } from '../generated/prisma/client.js'

/**
 * Phase 1b: bot 私下笔记的存取。
 *
 * 写入只来自 IdleThread (Phase 1c)。读取来自:
 * - reactive @ 路径,注入到 ephemeralSuffix (Phase 1d, withinHours=1)
 * - admin-web /inner-journal 时间线观测面 (Phase 1c 顺手加)
 *
 * 不进 MemoryProposal/SelfSpine 治理 (MVP 阶段是 transient 私笔记)。
 */

export interface InnerJournalEntry {
  id: number
  sceneId: string
  content: string
  sourceEventIds: string[]
  createdAt: Date
}

export interface InnerJournalCreateInput {
  sceneId: string
  content: string
  sourceEventIds?: string[]
}

export interface InnerJournalLastQuery {
  sceneId: string
  /** 最多取多少条,默认 1 */
  limit?: number
  /** 只取这么多小时内的(基于 created_at)。不传则不限时间。 */
  withinHours?: number
}

function fromRow(row: {
  id: number
  sceneId: string
  content: string
  sourceEventIds: Prisma.JsonValue
  createdAt: Date
}): InnerJournalEntry {
  const ids = Array.isArray(row.sourceEventIds)
    ? row.sourceEventIds.filter((value): value is string => typeof value === 'string')
    : []
  return {
    id: row.id,
    sceneId: row.sceneId,
    content: row.content,
    sourceEventIds: ids,
    createdAt: row.createdAt,
  }
}

export interface InnerJournalStore {
  create(input: InnerJournalCreateInput): Promise<InnerJournalEntry>
  last(query: InnerJournalLastQuery): Promise<InnerJournalEntry[]>
}

export const innerJournalStore: InnerJournalStore = {
  async create(input) {
    const row = await prisma.innerJournal.create({
      data: {
        sceneId: input.sceneId,
        content: input.content,
        sourceEventIds: (input.sourceEventIds ?? []) as Prisma.InputJsonValue,
      },
    })
    return fromRow(row)
  },

  async last(query) {
    const limit = Math.max(1, Math.min(query.limit ?? 1, 50))
    const where: Prisma.InnerJournalWhereInput = { sceneId: query.sceneId }
    if (query.withinHours != null && query.withinHours > 0) {
      const cutoff = new Date(Date.now() - query.withinHours * 60 * 60 * 1000)
      where.createdAt = { gte: cutoff }
    }
    const rows = await prisma.innerJournal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return rows.map(fromRow)
  },
}
