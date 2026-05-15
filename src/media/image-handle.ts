import { prisma } from '../database/client.js'
import { getOutboundCache } from './outbound-cache.js'
import type { ImageHandle, ResolvedImage } from './image-handle-schema.js'

export async function resolveImageHandle(
  handle: ImageHandle,
  opts: { acquire?: boolean } = {},
): Promise<ResolvedImage> {
  if ('mediaId' in handle) {
    const media = await prisma.media.findUnique({
      where: { mediaId: handle.mediaId },
    })
    if (!media) {
      throw new Error(`Media not found: mediaId=${handle.mediaId}`)
    }
    return {
      bytes: Buffer.from(media.data),
      dataHash: media.dataHash ?? '',
      byteSize: media.data.byteLength,
      contentType: media.contentType ?? 'application/octet-stream',
      description: extractDescription(media.descriptionRaw),
    }
  }

  const cache = getOutboundCache()
  const shouldAcquire = opts.acquire !== false
  const entry = shouldAcquire
    ? cache.acquire(handle.ephemeralRef)
    : cache.get(handle.ephemeralRef)

  if (!entry) {
    throw new Error(`Ephemeral image expired or not found: ${handle.ephemeralRef.slice(0, 16)}…`)
  }

  return {
    bytes: entry.bytes,
    dataHash: entry.dataHash,
    byteSize: entry.byteSize,
    contentType: entry.contentType,
    description: entry.description,
  }
}

export function releaseHandle(handle: ImageHandle): void {
  if ('ephemeralRef' in handle) {
    getOutboundCache().release(handle.ephemeralRef)
  }
}

function extractDescription(raw: unknown): string {
  if (raw && typeof raw === 'object' && 'description' in raw) {
    return String((raw as Record<string, unknown>).description)
  }
  return ''
}
