import { prisma } from '../database/client.js'
import { generateDescriptionForMedia } from '../jobs/generate-description.js'
import type { RouteHandler } from './http.js'

export const handleMediaReanalyze: RouteHandler = async (params) => {
  const mediaId = Number(params.id)
  if (!Number.isFinite(mediaId) || mediaId <= 0) {
    throw new Error('Invalid mediaId')
  }

  const media = await prisma.media.findUnique({
    where: { mediaId },
    select: { mediaId: true, mediaType: true, contentType: true, fileName: true },
  })

  if (!media) {
    throw new Error(`Media ${mediaId} not found`)
  }

  // Clear existing description so generateDescriptionForMedia won't skip
  await prisma.media.update({
    where: { mediaId },
    data: { description: null },
  })

  await generateDescriptionForMedia(mediaId)

  const updated = await prisma.media.findUnique({
    where: { mediaId },
    select: { description: true },
  })

  return {
    ok: true,
    mediaId,
    mediaType: media.mediaType,
    description: updated?.description ?? null,
  }
}
