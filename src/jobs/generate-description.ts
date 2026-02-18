import { prisma } from '../database/client.js'
import { getLlmProvider } from '../llm/provider.js'
import { log } from '../logger.js'
import type { Job } from '../queue/types.js'

export interface GenerateDescriptionData {
  mediaId: number
}

const VISION_MEDIA_TYPES = new Set(['image', 'sticker', 'video'])

export async function handleGenerateDescription(
  job: Job<'generate-description', GenerateDescriptionData>,
): Promise<void> {
  const { mediaId } = job.data

  const media = await prisma.media.findUnique({
    where: { mediaId },
    select: { data: true, contentType: true, mediaType: true, description: true },
  })

  if (!media) {
    log.warn({ mediaId, jobId: job.id }, '媒体记录不存在，跳过描述生成')
    return
  }

  if (media.description) {
    log.debug({ mediaId, jobId: job.id }, '描述已存在，跳过')
    return
  }

  const provider = getLlmProvider()
  if (!provider) {
    log.debug({ mediaId, jobId: job.id }, 'LLM provider 未配置，跳过描述生成')
    return
  }

  const mediaType = media.mediaType ?? 'unknown'

  if (VISION_MEDIA_TYPES.has(mediaType)) {
    const buffer = Buffer.from(media.data)
    if (buffer.length === 0) {
      log.debug({ mediaId, jobId: job.id }, '媒体数据为空，跳过描述生成')
      return
    }

    const description = await provider.describeImage({
      image: buffer,
      contentType: media.contentType ?? 'application/octet-stream',
      mediaType,
    })

    await prisma.media.update({
      where: { mediaId },
      data: { description },
    })

    log.info({ mediaId, jobId: job.id }, '媒体描述已生成')
    return
  }

  if (mediaType === 'record') {
    if (!provider.transcribeAudio) {
      log.debug({ mediaId, jobId: job.id }, 'LLM provider 不支持语音转写，跳过')
      return
    }

    const buffer = Buffer.from(media.data)
    if (buffer.length === 0) {
      log.debug({ mediaId, jobId: job.id }, '语音数据为空，跳过')
      return
    }

    const description = await provider.transcribeAudio({
      audio: buffer,
      contentType: media.contentType ?? 'audio/mp4',
    })

    await prisma.media.update({
      where: { mediaId },
      data: { description },
    })

    log.info({ mediaId, jobId: job.id }, '语音转写已完成')
    return
  }

  if (mediaType === 'file') {
    log.debug({ mediaId, jobId: job.id }, '文件文本提取暂未实现，跳过')
    return
  }

  log.debug({ mediaId, mediaType, jobId: job.id }, '不支持的媒体类型，跳过描述生成')
}
