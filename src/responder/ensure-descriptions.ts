import { prisma } from '../database/client.js'
import type { Message } from '../generated/prisma/client.js'
import type { ParsedSegment } from '../types/message-segments.js'
import { generateDescriptionForMedia } from '../jobs/generate-description.js'
import { log } from '../logger.js'

export function collectReferenceIds(segmentGroups: ParsedSegment[][]): number[] {
  const ids: number[] = []
  for (const segments of segmentGroups) {
    for (const seg of segments) {
      if (
        // 'image' 覆盖贴纸（贴纸以 ImageSegment subType===1 存储，DB mediaType 字段才被标记为 'sticker'）
        (seg.type === 'image' || seg.type === 'video' || seg.type === 'record' || seg.type === 'file') &&
        typeof seg.referenceId === 'string'
      ) {
        const mediaId = Number(seg.referenceId)
        if (Number.isInteger(mediaId) && mediaId > 0) {
          ids.push(mediaId)
        }
      }
    }
  }
  return ids
}

export async function ensureDescriptions(messages: Message[], timeoutMs: number): Promise<void> {
  const segmentGroups = messages.map((m) => m.content as unknown as ParsedSegment[])
  const allIds = collectReferenceIds(segmentGroups)
  if (allIds.length === 0) return

  const mediaRows = await prisma.media.findMany({
    where: { mediaId: { in: allIds }, description: null },
    select: { mediaId: true },
  })

  const pendingIds = mediaRows.map((r) => r.mediaId)
  if (pendingIds.length === 0) return

  log.debug({ count: pendingIds.length }, '等待媒体描述生成')

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  const all = Promise.allSettled(pendingIds.map((id) => generateDescriptionForMedia(id)))

  await Promise.race([all, timeout])
}
