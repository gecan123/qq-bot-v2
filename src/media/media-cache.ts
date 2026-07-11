import { prisma } from '../database/client.js'
import { createLogger } from '../logger.js'
import { jobQueue } from '../queue/runtime.js'
import { computeMediaHash } from './media-hash.js'
import type {
  ImageSegment,
  VideoSegment,
  RecordSegment,
  FileSegment,
  ParsedSegment,
} from '../types/message-segments.js'
import type { NCWebsocket } from 'node-napcat-ts'

type MediaSegment = ImageSegment | VideoSegment | RecordSegment | FileSegment
const log = createLogger('MEDIA')
const pendingMediaDownloads = new Map<number, Promise<void>>()

function resolveMediaType(segment: MediaSegment): string {
  if (segment.type === 'image') {
    return segment.subType === 1 ? 'sticker' : 'image'
  }
  return segment.type
}

const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024 // 20MB

function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB'
}

const MEDIA_TYPE_LABEL: Record<string, string> = {
  image: '图片',
  sticker: '贴纸',
  video: '视频',
  record: '语音',
  file: '文件',
}

function buildOversizeDescription(segment: MediaSegment, mediaType: string, fileSize: number): string {
  const label = MEDIA_TYPE_LABEL[mediaType] ?? '媒体'
  const size = formatMB(fileSize)
  if (mediaType === 'file' && segment.fileName) {
    return `[${label}] 文件过大（${segment.fileName}, ${size}），跳过解析`
  }
  return `[${label}] 文件过大（${size}），跳过解析`
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.amr': 'audio/amr', '.silk': 'audio/silk', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
}

function resolveContentType(headerContentType: string | undefined, fileName: string | undefined): string | undefined {
  if (headerContentType && headerContentType !== 'application/octet-stream') return headerContentType
  if (!fileName) return headerContentType
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  return MIME_BY_EXT[ext] ?? headerContentType
}

type MediaScope =
  | { kind: 'group'; groupId: number }
  | { kind: 'private'; peerId: number }

interface CacheInput {
  scope: MediaScope
  messageId: number
  senderId: number
  segment: MediaSegment
  napcat: NCWebsocket
}

function isMediaSegment(segment: ParsedSegment): segment is MediaSegment {
  return segment.type === 'image' || segment.type === 'video' || segment.type === 'record' || segment.type === 'file'
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

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002'
}

async function resolveMediaUrl(
  segment: MediaSegment,
  scope: MediaScope,
  napcat: NCWebsocket,
): Promise<string | undefined> {
  // All media types may have a URL directly
  if (segment.url) return segment.url

  if (!segment.fileName) return undefined

  // Fallback: resolve URL via API for types that support it
  if (segment.type === 'record') {
    const result = await napcat.get_record({ file: segment.fileName })
    return (result as { url?: string }).url
  }

  if (segment.type === 'file') {
    if (segment.fileId && scope.kind === 'group') {
      const result = await napcat.get_group_file_url({
        group_id: scope.groupId,
        file_id: segment.fileId,
      })
      return result.url
    }
    if (segment.fileId && scope.kind === 'private') {
      const result = await napcat.get_private_file_url({ file_id: segment.fileId })
      return result.url
    }
    const result = await napcat.get_file({ file: segment.fileName })
    return (result as { url?: string }).url
  }

  return undefined
}

function parseFileSize(fileSize?: string): number | undefined {
  if (!fileSize) return undefined
  const parsed = parseInt(fileSize, 10)
  return isNaN(parsed) ? undefined : parsed
}

async function cacheMediaSegment(input: CacheInput): Promise<string | undefined> {
  const { segment, scope, napcat } = input

  const fileSizeBytes = parseFileSize(segment.fileSize)

  // Skip download for files over 20MB, but still create a metadata-only record
  if (fileSizeBytes && fileSizeBytes > MAX_DOWNLOAD_SIZE) {
    const mediaType = resolveMediaType(segment)
    log.info(
      { type: segment.type, fileName: segment.type !== 'image' ? segment.fileName : undefined, fileSize: fileSizeBytes },
      '媒体文件超过20MB，仅保存元数据'
    )
    const media = await prisma.media.create({
      data: {
        data: new Uint8Array(0),
        mediaType,
        fileName: segment.type !== 'image' ? segment.fileName : (segment as ImageSegment).fileName,
        fileSize: fileSizeBytes,
        descriptionRaw: {
          description: buildOversizeDescription(segment, mediaType, fileSizeBytes),
          skippedReason: 'oversize',
          fileSizeBytes,
        },
      },
    })
    return String(media.mediaId)
  }

  const media = await prisma.media.create({
    data: {
      data: new Uint8Array(0),
      mediaType: resolveMediaType(segment),
      fileName: segment.fileName,
      fileSize: fileSizeBytes,
    },
  })
  const mediaId = media.mediaId

  const download = downloadMediaIntoPlaceholder(mediaId, segment, scope, napcat)
    .catch((error) => {
      log.warn(
        {
          mediaId,
          mediaType: segment.type,
          error: formatError(error),
        },
        '媒体异步下载失败，保留占位记录',
      )
    })
    .finally(() => {
      if (pendingMediaDownloads.get(mediaId) === download) {
        pendingMediaDownloads.delete(mediaId)
      }
    })
  pendingMediaDownloads.set(mediaId, download)

  return String(mediaId)
}

async function downloadMediaIntoPlaceholder(
  mediaId: number,
  segment: MediaSegment,
  scope: MediaScope,
  napcat: NCWebsocket,
): Promise<void> {
  const url = await resolveMediaUrl(segment, scope, napcat)
  if (!url) {
    log.warn({ mediaId, mediaType: segment.type }, '媒体 URL 缺失，保留占位记录')
    return
  }

  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(`media_download_failed: ${JSON.stringify(formatError(error))}`)
  }

  if (!response.ok) {
    throw new Error(`media_download_failed: status=${response.status}`)
  }

  let bytes: Buffer
  try {
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw new Error(`media_read_failed: ${JSON.stringify(formatError(error))}`)
  }

  const contentType = resolveContentType(response.headers.get('content-type') ?? undefined, segment.fileName)
  const fileSize = bytes.length
  const dataHash = computeMediaHash(bytes)

  const existing = await prisma.media.findUnique({
    where: { dataHash },
    select: {
      data: true,
      mediaType: true,
      contentType: true,
      fileName: true,
      fileSize: true,
      descriptionRaw: true,
    },
  })
  if (existing) {
    await prisma.media.update({
      where: { mediaId },
      data: {
        data: existing.data,
        mediaType: existing.mediaType,
        contentType: existing.contentType,
        fileName: existing.fileName,
        fileSize: existing.fileSize,
        descriptionRaw: existing.descriptionRaw ?? undefined,
      },
    })
    if (!existing.descriptionRaw) {
      jobQueue.enqueue('generate-description', { mediaId }, { priority: 'low' })
    }
    return
  }

  try {
    await prisma.media.update({
      where: { mediaId },
      data: {
        data: new Uint8Array(bytes),
        dataHash,
        mediaType: resolveMediaType(segment),
        contentType,
        fileName: segment.fileName,
        fileSize,
      },
    })
    jobQueue.enqueue('generate-description', { mediaId }, { priority: 'low' })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const deduped = await prisma.media.findUnique({
        where: { dataHash },
        select: {
          data: true,
          mediaType: true,
          contentType: true,
          fileName: true,
          fileSize: true,
          descriptionRaw: true,
        },
      })
      if (deduped) {
        await prisma.media.update({
          where: { mediaId },
          data: {
            data: deduped.data,
            mediaType: deduped.mediaType,
            contentType: deduped.contentType,
            fileName: deduped.fileName,
            fileSize: deduped.fileSize,
            descriptionRaw: deduped.descriptionRaw ?? undefined,
          },
        })
        if (!deduped.descriptionRaw) {
          jobQueue.enqueue('generate-description', { mediaId }, { priority: 'low' })
        }
        return
      }
    }
    throw error
  }
}

export async function waitForPendingMediaDownloads(mediaIds: number[], timeoutMs: number): Promise<void> {
  const pending = mediaIds
    .map((mediaId) => pendingMediaDownloads.get(mediaId))
    .filter((promise): promise is Promise<void> => promise !== undefined)
  if (pending.length === 0) return

  const downloads = Promise.allSettled(pending).then(() => undefined)
  if (timeoutMs <= 0) {
    await downloads
    return
  }

  await Promise.race([
    downloads,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

export async function persistMediaReferences(params: {
  content: ParsedSegment[]
  scope: MediaScope
  messageId: number
  senderId: number
  napcat: NCWebsocket
}): Promise<{ content: ParsedSegment[]; mediaReferenceIds: string[] }> {
  const output: ParsedSegment[] = []
  const mediaReferenceIds: string[] = []

  for (const segment of params.content) {
    if (segment.type === 'forward') {
      const items = []
      for (const item of segment.items) {
        const nested = await persistMediaReferences({
          ...params,
          content: item.content,
          messageId: Number(item.messageId) || params.messageId,
          senderId: Number(item.senderId) || params.senderId,
        })
        mediaReferenceIds.push(...nested.mediaReferenceIds)
        items.push({ ...item, content: nested.content })
      }
      output.push({ ...segment, items })
      continue
    }

    if (!isMediaSegment(segment)) {
      output.push(segment)
      continue
    }

    try {
      const referenceId = await cacheMediaSegment({
        segment,
        scope: params.scope,
        messageId: params.messageId,
        senderId: params.senderId,
        napcat: params.napcat,
      })

      if (!referenceId) {
        output.push(segment)
        continue
      }

      mediaReferenceIds.push(referenceId)
      output.push({
        ...segment,
        referenceId,
        url: undefined,
      })
    } catch (error) {
      log.warn(
        {
          messageId: params.messageId,
          mediaType: segment.type,
          error: formatError(error),
        },
        '媒体写入数据库失败，保留原始数据'
      )
      output.push(segment)
    }
  }

  return { content: output, mediaReferenceIds }
}
