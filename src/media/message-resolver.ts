import { prisma } from '../database/client.js'
import type { Message } from '../generated/prisma/client.js'
import type { ParsedSegment, ImageSegment, VideoSegment, RecordSegment, FileSegment } from '../types/message-segments.js'

type MediaSegment = ImageSegment | VideoSegment | RecordSegment | FileSegment

function hasReferenceId(segment: ParsedSegment): segment is MediaSegment & { referenceId: string } {
  return (
    (segment.type === 'image' || segment.type === 'video' || segment.type === 'record' || segment.type === 'file') &&
    typeof (segment as MediaSegment).referenceId === 'string'
  )
}

export async function resolveMessage(message: Message): Promise<ParsedSegment[]> {
  const segments = message.content as unknown as ParsedSegment[]

  const refIds: string[] = []
  for (const seg of segments) {
    if (hasReferenceId(seg)) refIds.push(seg.referenceId)
  }

  if (refIds.length === 0) return segments

  const mediaRows = await prisma.media.findMany({
    where: { mediaId: { in: refIds.map(Number) } },
    select: { mediaId: true, description: true },
  })

  const descriptionMap = new Map<string, string>()
  for (const row of mediaRows) {
    if (row.description) descriptionMap.set(String(row.mediaId), row.description)
  }

  return segments.map((segment) => {
    if (!hasReferenceId(segment)) return segment
    const desc = descriptionMap.get(segment.referenceId)
    if (!desc) return segment

    if (segment.type === 'image') {
      return { ...segment, summary: desc }
    }
    return { ...segment, description: desc }
  })
}
