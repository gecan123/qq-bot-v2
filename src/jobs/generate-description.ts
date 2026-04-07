import { prisma } from '../database/client.js'
import { Prisma } from '../generated/prisma/client.js'
import { getLlmProvider } from '../llm/provider.js'
import { log } from '../logger.js'
import { jobQueue } from '../queue/runtime.js'
import { withInFlight } from '../utils/in-flight.js'
import type { Job } from '../queue/types.js'

export interface GenerateDescriptionData {
  mediaId: number
}

const VISION_MEDIA_TYPES = new Set(['image', 'sticker'])

const inFlight = new Map<number, Promise<void>>()

function normalizeDescription(description: string): string | null {
  const trimmed = description.trim()
  return trimmed ? trimmed : null
}

function toDescriptionRawInput(raw: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return Prisma.JsonNull
  return JSON.parse(JSON.stringify(raw)) as Prisma.InputJsonValue
}

function isPdfFile(contentType: string | null, fileName: string | null): boolean {
  if (contentType === 'application/pdf') return true
  return fileName?.toLowerCase().endsWith('.pdf') ?? false
}

export function generateDescriptionForMedia(mediaId: number): Promise<void> {
  return withInFlight(inFlight, mediaId, () => doGenerate(mediaId))
}

async function doGenerate(mediaId: number): Promise<void> {
  const media = await prisma.media.findUnique({
    where: { mediaId },
    select: { data: true, contentType: true, mediaType: true, description: true, fileName: true },
  })

  if (!media) {
    log.warn({ mediaId }, '媒体记录不存在，跳过描述生成')
    return
  }

  if (media.description) {
    log.debug({ mediaId }, '描述已存在，跳过')
    return
  }

  const provider = getLlmProvider()
  if (!provider) {
    log.debug({ mediaId }, 'LLM provider 未配置，跳过描述生成')
    return
  }

  const mediaType = media.mediaType ?? 'unknown'

  if (VISION_MEDIA_TYPES.has(mediaType)) {
    const buffer = Buffer.from(media.data)
    if (buffer.length === 0) {
      log.debug({ mediaId }, '媒体数据为空，跳过描述生成')
      return
    }

    const result = provider.describeImageDetailed
      ? await provider.describeImageDetailed({
          image: buffer,
          contentType: media.contentType ?? 'application/octet-stream',
          mediaType,
        })
      : {
          description: await provider.describeImage({
            image: buffer,
            contentType: media.contentType ?? 'application/octet-stream',
            mediaType,
          }),
        }
    const description = normalizeDescription(result.description)

    if (!description) {
      log.warn({ mediaId, mediaType }, '媒体描述结果为空，保留待解析状态')
      return
    }

    await prisma.media.update({
      where: { mediaId },
      data: { description, descriptionRaw: toDescriptionRawInput(result.raw) },
    })
    jobQueue.enqueue('refresh-message-resolution', { mediaId }, { priority: 'low' })
    log.info({ mediaId }, '媒体描述已生成')
    return
  }

  if (mediaType === 'video') {
    if (!provider.describeVideo) {
      log.debug({ mediaId }, 'LLM provider 不支持视频解析，跳过')
      return
    }

    const buffer = Buffer.from(media.data)
    if (buffer.length === 0) {
      log.debug({ mediaId }, '视频数据为空，跳过')
      return
    }

    const result = provider.describeVideoDetailed
      ? await provider.describeVideoDetailed({
          video: buffer,
          contentType: media.contentType ?? 'video/mp4',
          fileName: media.fileName ?? undefined,
        })
      : {
          description: await provider.describeVideo({
            video: buffer,
            contentType: media.contentType ?? 'video/mp4',
            fileName: media.fileName ?? undefined,
          }),
        }
    const description = normalizeDescription(result.description)

    if (!description) {
      log.warn({ mediaId, mediaType }, '媒体描述结果为空，保留待解析状态')
      return
    }

    await prisma.media.update({
      where: { mediaId },
      data: { description, descriptionRaw: toDescriptionRawInput(result.raw) },
    })
    jobQueue.enqueue('refresh-message-resolution', { mediaId }, { priority: 'low' })
    log.info({ mediaId }, '视频描述已生成')
    return
  }

  if (mediaType === 'record') {
    if (!provider.transcribeAudio) {
      log.debug({ mediaId }, 'LLM provider 不支持语音转写，跳过')
      return
    }

    const buffer = Buffer.from(media.data)
    if (buffer.length === 0) {
      log.debug({ mediaId }, '语音数据为空，跳过')
      return
    }

    const result = provider.transcribeAudioDetailed
      ? await provider.transcribeAudioDetailed({
          audio: buffer,
          contentType: media.contentType ?? 'audio/mp4',
        })
      : {
          description: await provider.transcribeAudio({
            audio: buffer,
            contentType: media.contentType ?? 'audio/mp4',
          }),
        }
    const description = normalizeDescription(result.description)

    if (!description) {
      log.warn({ mediaId, mediaType }, '媒体描述结果为空，保留待解析状态')
      return
    }

    await prisma.media.update({
      where: { mediaId },
      data: { description, descriptionRaw: toDescriptionRawInput(result.raw) },
    })
    jobQueue.enqueue('refresh-message-resolution', { mediaId }, { priority: 'low' })
    log.info({ mediaId }, '语音转写已完成')
    return
  }

  if (mediaType === 'file') {
    if (!isPdfFile(media.contentType ?? null, media.fileName ?? null)) {
      log.debug({ mediaId }, '文件解析暂未实现，跳过')
      return
    }

    if (!provider.describePdf) {
      log.debug({ mediaId }, 'LLM provider 不支持 PDF 解析，跳过')
      return
    }

    const buffer = Buffer.from(media.data)
    if (buffer.length === 0) {
      log.debug({ mediaId }, 'PDF 数据为空，跳过')
      return
    }

    const result = provider.describePdfDetailed
      ? await provider.describePdfDetailed({
          file: buffer,
          contentType: media.contentType ?? 'application/pdf',
          fileName: media.fileName ?? undefined,
        })
      : {
          description: await provider.describePdf({
            file: buffer,
            contentType: media.contentType ?? 'application/pdf',
            fileName: media.fileName ?? undefined,
          }),
        }
    const description = normalizeDescription(result.description)

    if (!description) {
      log.warn({ mediaId, mediaType }, '媒体描述结果为空，保留待解析状态')
      return
    }

    await prisma.media.update({
      where: { mediaId },
      data: { description, descriptionRaw: toDescriptionRawInput(result.raw) },
    })
    jobQueue.enqueue('refresh-message-resolution', { mediaId }, { priority: 'low' })
    log.info({ mediaId }, 'PDF 描述已生成')
    return
  }

  log.debug({ mediaId, mediaType }, '不支持的媒体类型，跳过描述生成')
}

export async function handleGenerateDescription(
  job: Job<'generate-description', GenerateDescriptionData>,
): Promise<void> {
  log.debug({ jobId: job.id, mediaId: job.data.mediaId }, '队列任务开始处理媒体描述')
  return generateDescriptionForMedia(job.data.mediaId)
}
