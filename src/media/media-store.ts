import { prisma } from '../database/client.js'
import type { Prisma } from '../generated/prisma/client.js'

export interface AttachMediaBlobInput {
  mediaId: number
  bytes: Buffer
  dataHash: string
  mediaType: string
  contentType?: string
  fileName?: string
  fileSize: number
}

export interface CreateMediaFromBytesInput {
  bytes: Buffer
  dataHash: string
  mediaType: string
  contentType?: string
  fileName?: string
  descriptionRaw?: Prisma.InputJsonValue
}

export interface ResolvedMediaRecord {
  mediaId: number
  data: Uint8Array
  dataHash: string | null
  byteSize: number
  mediaType: string | null
  contentType: string | null
  fileName: string | null
  fileSize: number | null
  descriptionRaw: unknown
}

export async function attachMediaBlob(input: AttachMediaBlobInput): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const blob = await tx.mediaBlob.upsert({
      where: { dataHash: input.dataHash },
      create: {
        dataHash: input.dataHash,
        data: new Uint8Array(input.bytes),
        byteSize: input.bytes.byteLength,
      },
      update: { touchedAt: new Date() },
      select: { blobId: true, byteSize: true },
    })
    assertMatchingBlobSize(input.dataHash, blob.byteSize, input.bytes.byteLength)

    await tx.media.update({
      where: { mediaId: input.mediaId },
      data: {
        blobId: blob.blobId,
        mediaType: input.mediaType,
        contentType: input.contentType,
        fileName: input.fileName,
        fileSize: input.fileSize,
      },
    })
    return blob.blobId
  })
}

export async function createMediaFromBytes(input: CreateMediaFromBytesInput): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const blob = await tx.mediaBlob.upsert({
      where: { dataHash: input.dataHash },
      create: {
        dataHash: input.dataHash,
        data: new Uint8Array(input.bytes),
        byteSize: input.bytes.byteLength,
      },
      update: { touchedAt: new Date() },
      select: { blobId: true, byteSize: true },
    })
    assertMatchingBlobSize(input.dataHash, blob.byteSize, input.bytes.byteLength)

    const media = await tx.media.create({
      data: {
        blobId: blob.blobId,
        mediaType: input.mediaType,
        contentType: input.contentType,
        fileName: input.fileName,
        fileSize: input.bytes.byteLength,
        descriptionRaw: input.descriptionRaw,
      },
      select: { mediaId: true },
    })
    return media.mediaId
  })
}

export async function findResolvedMedia(mediaId: number): Promise<ResolvedMediaRecord | null> {
  const media = await prisma.media.findUnique({
    where: { mediaId },
    select: {
      mediaId: true,
      mediaType: true,
      contentType: true,
      fileName: true,
      fileSize: true,
      descriptionRaw: true,
      blob: {
        select: {
          data: true,
          dataHash: true,
          byteSize: true,
        },
      },
    },
  })
  if (!media) return null

  return {
    mediaId: media.mediaId,
    data: media.blob?.data ?? new Uint8Array(0),
    dataHash: media.blob?.dataHash ?? null,
    byteSize: media.blob?.byteSize ?? 0,
    mediaType: media.mediaType,
    contentType: media.contentType,
    fileName: media.fileName,
    fileSize: media.fileSize,
    descriptionRaw: media.descriptionRaw,
  }
}

function assertMatchingBlobSize(dataHash: string, storedSize: number, incomingSize: number): void {
  if (storedSize === incomingSize) return
  throw new Error(
    `media_blob_hash_collision_or_corruption: hash=${dataHash} storedSize=${storedSize} incomingSize=${incomingSize}`,
  )
}
