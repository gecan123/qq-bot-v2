import { prisma } from '../database/client.js'
import { log } from '../logger.js'
import type { ImageSegment, ParsedSegment } from '../types/message-segments.js'

interface CacheInput {
  groupId: number
  messageId: number
  senderId: number
  segment: ImageSegment
}

function isImageSegment(segment: ParsedSegment): segment is ImageSegment {
  return segment.type === 'image'
}

function formatError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string; errno?: number; syscall?: string }
    return {
      name: error.name,
      message: error.message,
      code: withCode.code,
      errno: withCode.errno,
      syscall: withCode.syscall,
      stack: error.stack,
    }
  }

  return { value: String(error) }
}

async function cacheImageSegment(input: CacheInput): Promise<string | undefined> {
  const { segment } = input
  if (!segment.url) return undefined

  let response: Response
  try {
    response = await fetch(segment.url)
  } catch (error) {
    throw new Error(`image_download_failed: ${JSON.stringify(formatError(error))}`)
  }

  if (!response.ok) {
    throw new Error(`image_download_failed: status=${response.status}`)
  }

  let bytes: Buffer
  try {
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw new Error(`image_read_failed: ${JSON.stringify(formatError(error))}`)
  }

  const contentType = response.headers.get('content-type') ?? undefined
  const fileSize = bytes.length

  const media = await prisma.media.create({
    data: {
      data: new Uint8Array(bytes),
      contentType,
      fileName: segment.fileName,
      fileSize,
    },
  })

  return String(media.mediaId)
}

export async function persistImageReferences(params: {
  content: ParsedSegment[]
  groupId: number
  messageId: number
  senderId: number
}): Promise<{ content: ParsedSegment[]; imageReferenceIds: string[] }> {
  const output: ParsedSegment[] = []
  const imageReferenceIds: string[] = []

  for (const segment of params.content) {
    if (!isImageSegment(segment)) {
      output.push(segment)
      continue
    }

    try {
      const referenceId = await cacheImageSegment({
        segment,
        groupId: params.groupId,
        messageId: params.messageId,
        senderId: params.senderId,
      })

      if (!referenceId) {
        output.push(segment)
        continue
      }

      imageReferenceIds.push(referenceId)
      output.push({
        ...segment,
        referenceId,
        url: undefined,
      })
    } catch (error) {
      log.warn(
        {
          messageId: params.messageId,
          imageUrl: segment.url,
          error: formatError(error),
        },
        '图片写入数据库失败，保留原始链接'
      )
      output.push(segment)
    }
  }

  return { content: output, imageReferenceIds }
}
