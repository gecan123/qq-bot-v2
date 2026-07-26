import { createLogger } from '../logger.js'
import { createMediaFromBytes } from './media-store.js'

const log = createLogger('PROMOTE_OUTBOUND')

export interface PromoteInput {
  bytes: Buffer
  dataHash: string
  contentType: string
  description?: string
  descriptionSource?: string
  mediaType?: string
}

export type MediaFromBytesCreator = typeof createMediaFromBytes

export async function promoteToMedia(
  input: PromoteInput,
  createMedia: MediaFromBytesCreator = createMediaFromBytes,
): Promise<number> {
  const descriptionRaw = input.description == null
    ? undefined
    : { description: input.description, source: input.descriptionSource ?? 'outbound' }

  const mediaId = await createMedia({
    bytes: input.bytes,
    dataHash: input.dataHash,
    contentType: input.contentType,
    mediaType: input.mediaType ?? 'image',
    ...(descriptionRaw == null ? {} : { descriptionRaw }),
  })

  log.info(
    { mediaId, dataHash: input.dataHash.slice(0, 16), byteSize: input.bytes.byteLength },
    'promote_outbound_success',
  )

  return mediaId
}
