import { prisma } from '../database/client.js'
import { createLogger } from '../logger.js'

const log = createLogger('PROMOTE_OUTBOUND')

export interface PromoteInput {
  bytes: Buffer
  dataHash: string
  contentType: string
  description: string
  mediaType?: string
}

export async function promoteToMedia(input: PromoteInput): Promise<number> {
  const descriptionRaw = { description: input.description, source: 'outbound' }

  const row = await prisma.media.upsert({
    where: { dataHash: input.dataHash },
    create: {
      data: new Uint8Array(input.bytes),
      dataHash: input.dataHash,
      contentType: input.contentType,
      mediaType: input.mediaType ?? 'image',
      fileSize: input.bytes.byteLength,
      descriptionRaw,
    },
    update: {},
    select: { mediaId: true },
  })

  log.info(
    { mediaId: row.mediaId, dataHash: input.dataHash.slice(0, 16), byteSize: input.bytes.byteLength },
    'promote_outbound_success',
  )

  return row.mediaId
}
