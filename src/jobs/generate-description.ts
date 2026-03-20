import { prisma } from '../database/client.js'
import { getLlmProvider } from '../llm/provider.js'
import { log } from '../logger.js'
import { withInFlight } from '../utils/in-flight.js'
import type { Job } from '../queue/types.js'

export interface GenerateDescriptionData {
  mediaId: number
}

const VISION_MEDIA_TYPES = new Set(['image', 'sticker'])
// 视频不支持直接作为 image_url 输入（gpt-5.4/5.4-mini 均不支持 video/mp4 MIME type）

const inFlight = new Map<number, Promise<void>>()

export function generateDescriptionForMedia(mediaId: number): Promise<void> {
  return withInFlight(inFlight, mediaId, () => doGenerate(mediaId))
}

async function doGenerate(mediaId: number): Promise<void> {
  const media = await prisma.media.findUnique({
    where: { mediaId },
    select: { data: true, contentType: true, mediaType: true, description: true },
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

    const description = await provider.describeImage({
      image: buffer,
      contentType: media.contentType ?? 'application/octet-stream',
      mediaType,
    })

    await prisma.media.update({ where: { mediaId }, data: { description } })
    log.info({ mediaId }, '媒体描述已生成')
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

    const description = await provider.transcribeAudio({
      audio: buffer,
      contentType: media.contentType ?? 'audio/mp4',
    })

    await prisma.media.update({ where: { mediaId }, data: { description } })
    log.info({ mediaId }, '语音转写已完成')
    return
  }

  if (mediaType === 'file') {
    log.debug({ mediaId }, '文件文本提取暂未实现，跳过')
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
