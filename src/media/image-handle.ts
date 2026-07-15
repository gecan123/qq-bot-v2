import { prisma } from '../database/client.js'
import { getOutboundCache } from './outbound-cache.js'
import type { ImageHandle, ResolvedImage } from './image-handle-schema.js'

interface PersistedImageClient {
  media: {
    findUnique(args: unknown): Promise<{
      data: Uint8Array
      dataHash?: string | null
      contentType?: string | null
      descriptionRaw?: unknown
    } | null>
  }
}

export async function resolvePersistedImage(
  mediaId: number | string,
  client: PersistedImageClient = prisma as unknown as PersistedImageClient,
): Promise<ResolvedImage | null> {
  const normalized = typeof mediaId === 'string' ? Number(mediaId) : mediaId
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`invalid media id: ${String(mediaId)}`)
  }
  const media = await client.media.findUnique({ where: { mediaId: normalized } })
  if (!media) return null
  return {
    bytes: Buffer.from(media.data),
    dataHash: media.dataHash ?? '',
    byteSize: media.data.byteLength,
    contentType: media.contentType ?? 'application/octet-stream',
    description: extractDescription(media.descriptionRaw),
  }
}

export async function resolveImageHandle(
  handle: ImageHandle,
  opts: { acquire?: boolean } = {},
): Promise<ResolvedImage> {
  if ('mediaId' in handle) {
    const media = await resolvePersistedImage(handle.mediaId)
    if (media == null) {
      throw new Error(`Media not found: mediaId=${handle.mediaId}`)
    }
    return media
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
