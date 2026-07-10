import { prisma } from '../database/client.js'
import { Prisma, type Message } from '../generated/prisma/client.js'
import type { ParsedSegment, ImageSegment, VideoSegment, RecordSegment, FileSegment } from '../types/message-segments.js'
import { isMediaDescription } from './media-description.js'
import { jobQueue } from '../queue/runtime.js'
import { waitForPendingMediaDownloads } from './media-cache.js'

type MediaSegment = ImageSegment | VideoSegment | RecordSegment | FileSegment
type ResolvePriority = 'high' | 'normal' | 'low'
const scheduledDescriptionJobs = new Map<number, Promise<void>>()

export interface ResolveMessageOptions {
  timeoutMs?: number
  priority?: ResolvePriority
}

function hasReferenceId(segment: ParsedSegment): segment is MediaSegment & { referenceId: string } {
  return (
    (segment.type === 'image' || segment.type === 'video' || segment.type === 'record' || segment.type === 'file') &&
    typeof (segment as MediaSegment).referenceId === 'string'
  )
}

function collectReferenceIds(segments: ParsedSegment[]): number[] {
  const refIds: number[] = []
  for (const seg of segments) {
    if (seg.type === 'forward') {
      for (const item of seg.items) refIds.push(...collectReferenceIds(item.content))
      continue
    }
    if (!hasReferenceId(seg)) continue
    const mediaId = Number(seg.referenceId)
    if (Number.isInteger(mediaId) && mediaId > 0) refIds.push(mediaId)
  }
  return refIds
}

function applyDescriptions(
  segments: ParsedSegment[],
  descriptionMap: ReadonlyMap<string, Record<string, unknown>>,
): ParsedSegment[] {
  return segments.map((segment) => {
    if (segment.type === 'forward') {
      return {
        ...segment,
        items: segment.items.map((item) => ({
          ...item,
          content: applyDescriptions(item.content, descriptionMap),
        })),
      }
    }
    if (!hasReferenceId(segment)) return segment
    const desc = descriptionMap.get(segment.referenceId)
    if (!desc) return segment
    return { ...segment, mediaDescription: desc }
  })
}

async function ensureDescriptions(refIds: number[], options: ResolveMessageOptions): Promise<void> {
  if (refIds.length === 0) return

  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? 0
  if (timeoutMs > 0) {
    await waitForPendingMediaDownloads(refIds, timeoutMs)
  }

  const pendingRows = await prisma.media.findMany({
    where: { mediaId: { in: refIds }, descriptionRaw: { equals: Prisma.AnyNull } },
    select: { mediaId: true },
  })
  const pendingIds = pendingRows.map((row) => row.mediaId)
  if (pendingIds.length === 0) return

  const priority = options.priority ?? 'high'
  const schedule = (mediaId: number): Promise<void> => {
    const existing = scheduledDescriptionJobs.get(mediaId)
    if (existing) return existing

    const scheduled = jobQueue
      .enqueueAndWait('generate-description', { mediaId }, { priority })
      .finally(() => {
        if (scheduledDescriptionJobs.get(mediaId) === scheduled) {
          scheduledDescriptionJobs.delete(mediaId)
        }
      })

    scheduledDescriptionJobs.set(mediaId, scheduled)
    return scheduled
  }

  if (timeoutMs <= 0) {
    for (const mediaId of pendingIds) {
      void schedule(mediaId).catch(() => {})
    }
    return
  }

  const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, remainingMs))
  const all = Promise.allSettled(
    pendingIds.map((mediaId) => schedule(mediaId)),
  )

  await Promise.race([all, timeout])
}

async function resolveDescriptions(segments: ParsedSegment[], refIds: number[]): Promise<ParsedSegment[]> {
  if (refIds.length === 0) return segments

  const mediaRows = await prisma.media.findMany({
    where: { mediaId: { in: refIds } },
    select: { mediaId: true, descriptionRaw: true },
  })

  const descriptionMap = new Map<string, Record<string, unknown>>()
  for (const row of mediaRows) {
    if (isMediaDescription(row.descriptionRaw)) descriptionMap.set(String(row.mediaId), row.descriptionRaw)
  }

  return applyDescriptions(segments, descriptionMap)
}

export async function resolveMessage(message: Message, options: ResolveMessageOptions = {}): Promise<ParsedSegment[]> {
  const segments = message.content as unknown as ParsedSegment[]
  const refIds = collectReferenceIds(segments)

  await ensureDescriptions(refIds, options)
  return resolveDescriptions(segments, refIds)
}
