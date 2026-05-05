import { prisma } from '../database/client.js'
import { Prisma } from '../generated/prisma/client.js'
import { getLlmProvider } from '../llm/provider.js'
import type { RoutingScenario } from '../llm/routing-provider.js'
import { createLogger } from '../logger.js'
import { isMediaDescription } from '../media/media-description.js'
import { withInFlight } from '../utils/in-flight.js'
import type { Job } from '../queue/types.js'
import type { MediaDescriptionResult } from '../llm/types.js'

export interface GenerateDescriptionData {
  mediaId: number
}

const VISION_MEDIA_TYPES = new Set(['image', 'sticker'])

const SENSITIVE_CONTENT_FALLBACK = {
  detectedType: 'sensitive_content',
  summary: '内容受限',
  description: '图片内容无法详述，可能包含敏感元素或超出解析能力',
  extractedText: [] as string[],
  memeContext: '',
  confidence: 0.1,
  intentSignal: 'unknown',
}

const inFlight = new Map<number, Promise<void>>()
const log = createLogger('JOB_MEDIA')

function getScenarioProvider(
  provider: ReturnType<typeof getLlmProvider>,
  scenario: RoutingScenario,
): ReturnType<typeof getLlmProvider> {
  if (provider && 'getProviderForScenario' in provider && typeof provider.getProviderForScenario === 'function') {
    return provider.getProviderForScenario(scenario)
  }
  return provider
}

function getProviderModel(provider: ReturnType<typeof getLlmProvider>, scenario: RoutingScenario): string {
  return getScenarioProvider(provider, scenario)?.model?.trim() || 'unknown'
}

function logDescriptionGenerated(
  provider: ReturnType<typeof getLlmProvider>,
  scenario: RoutingScenario,
  mediaId: number,
  startedAt: number,
  message: string,
): void {
  log.info(
    {
      mediaId,
      model: getProviderModel(provider, scenario),
      durationMs: Date.now() - startedAt,
    },
    message,
  )
}

async function runWithDescriptionFailureLog<T>(
  provider: ReturnType<typeof getLlmProvider>,
  scenario: RoutingScenario,
  mediaId: number,
  startedAt: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    log.error(
      {
        mediaId,
        scenario,
        model: getProviderModel(provider, scenario),
        durationMs: Date.now() - startedAt,
        error,
      },
      '媒体描述生成失败',
    )
    throw error
  }
}

async function wrapLegacyDescription(fn: () => Promise<string>): Promise<MediaDescriptionResult> {
  return { description: await fn() }
}

function toDescriptionRawInput(raw: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return Prisma.JsonNull
  return JSON.parse(JSON.stringify(raw)) as Prisma.InputJsonValue
}

function normalizeDescriptionRaw(raw: unknown, fallbackDescription?: string): Record<string, unknown> | null {
  if (isMediaDescription(raw)) return raw
  if (typeof fallbackDescription !== 'string') return null

  const trimmed = fallbackDescription.trim()
  if (!trimmed) return null
  return { description: trimmed }
}

function logInvalidDescriptionResult(
  mediaId: number,
  mediaType: string,
  result: { description?: string; raw?: unknown } | undefined,
): void {
  log.warn(
    {
      mediaId,
      mediaType,
      llmDescription: result?.description,
      llmRaw: result?.raw,
    },
    '媒体描述结果不是有效对象，写入 sensitive_content 兜底描述',
  )
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
    select: { data: true, contentType: true, mediaType: true, descriptionRaw: true, fileName: true },
  })

  if (!media) {
    log.warn({ mediaId }, '媒体记录不存在，跳过描述生成')
    return
  }

  if (media.descriptionRaw) {
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

    const startedAt = Date.now()
    const result: MediaDescriptionResult = await runWithDescriptionFailureLog(
      provider,
      'describeImage',
      mediaId,
      startedAt,
      async () =>
      provider.describeImageDetailed
        ? provider.describeImageDetailed({
            image: buffer,
            contentType: media.contentType ?? 'application/octet-stream',
            mediaType,
          })
        : wrapLegacyDescription(() =>
            provider.describeImage({
              image: buffer,
              contentType: media.contentType ?? 'application/octet-stream',
              mediaType,
            }),
          ),
    )
    const descriptionRaw = normalizeDescriptionRaw(result?.raw, result?.description)

    if (!descriptionRaw) {
      const hasInvalidShape = result?.raw !== null && result?.raw !== undefined
      if (hasInvalidShape) {
        logInvalidDescriptionResult(mediaId, mediaType, result)
        await prisma.media.update({
          where: { mediaId },
          data: { descriptionRaw: toDescriptionRawInput(SENSITIVE_CONTENT_FALLBACK) },
        })
      } else {
        log.warn({ mediaId, mediaType, llmDescription: result?.description }, '图片描述返回空结果，保留待解析状态供重试')
      }
      return
    }

    await prisma.media.update({
      where: { mediaId },
      data: { descriptionRaw: toDescriptionRawInput(descriptionRaw) },
    })
    logDescriptionGenerated(provider, 'describeImage', mediaId, startedAt, '媒体描述已生成')
    return
  }

  if (mediaType === 'video') {
    if (!provider.describeVideo) {
      log.debug({ mediaId }, 'LLM provider 不支持视频解析，跳过')
      return
    }
    const describeVideo = provider.describeVideo

    const buffer = Buffer.from(media.data)
    if (buffer.length === 0) {
      log.debug({ mediaId }, '视频数据为空，跳过')
      return
    }

    const startedAt = Date.now()
    const result: MediaDescriptionResult = await runWithDescriptionFailureLog(
      provider,
      'describeVideo',
      mediaId,
      startedAt,
      async () =>
      provider.describeVideoDetailed
        ? provider.describeVideoDetailed({
            video: buffer,
            contentType: media.contentType ?? 'video/mp4',
            fileName: media.fileName ?? undefined,
          })
        : wrapLegacyDescription(() =>
            describeVideo({
              video: buffer,
              contentType: media.contentType ?? 'video/mp4',
              fileName: media.fileName ?? undefined,
            }),
          ),
    )
    const descriptionRaw = normalizeDescriptionRaw(result?.raw, result?.description)

    if (!descriptionRaw) {
      logInvalidDescriptionResult(mediaId, mediaType, result)
      return
    }

    await prisma.media.update({
      where: { mediaId },
      data: { descriptionRaw: toDescriptionRawInput(descriptionRaw) },
    })
    logDescriptionGenerated(provider, 'describeVideo', mediaId, startedAt, '视频描述已生成')
    return
  }

  if (mediaType === 'record') {
    if (!provider.transcribeAudio) {
      log.debug({ mediaId }, 'LLM provider 不支持语音转写，跳过')
      return
    }
    const transcribeAudio = provider.transcribeAudio

    const buffer = Buffer.from(media.data)
    if (buffer.length === 0) {
      log.debug({ mediaId }, '语音数据为空，跳过')
      return
    }

    const startedAt = Date.now()
    const result: MediaDescriptionResult = await runWithDescriptionFailureLog(
      provider,
      'transcribeAudio',
      mediaId,
      startedAt,
      async () =>
      provider.transcribeAudioDetailed
        ? provider.transcribeAudioDetailed({
            audio: buffer,
            contentType: media.contentType ?? 'audio/mp4',
          })
        : wrapLegacyDescription(() =>
            transcribeAudio({
              audio: buffer,
              contentType: media.contentType ?? 'audio/mp4',
            }),
          ),
    )
    const descriptionRaw = normalizeDescriptionRaw(result?.raw, result?.description)

    if (!descriptionRaw) {
      logInvalidDescriptionResult(mediaId, mediaType, result)
      return
    }

    await prisma.media.update({
      where: { mediaId },
      data: { descriptionRaw: toDescriptionRawInput(descriptionRaw) },
    })
    logDescriptionGenerated(provider, 'transcribeAudio', mediaId, startedAt, '语音转写已完成')
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
    const describePdf = provider.describePdf

    const buffer = Buffer.from(media.data)
    if (buffer.length === 0) {
      log.debug({ mediaId }, 'PDF 数据为空，跳过')
      return
    }

    const startedAt = Date.now()
    const result: MediaDescriptionResult = await runWithDescriptionFailureLog(
      provider,
      'describePdf',
      mediaId,
      startedAt,
      async () =>
      provider.describePdfDetailed
        ? provider.describePdfDetailed({
            file: buffer,
            contentType: media.contentType ?? 'application/pdf',
            fileName: media.fileName ?? undefined,
          })
        : wrapLegacyDescription(() =>
            describePdf({
              file: buffer,
              contentType: media.contentType ?? 'application/pdf',
              fileName: media.fileName ?? undefined,
            }),
          ),
    )
    const descriptionRaw = normalizeDescriptionRaw(result?.raw, result?.description)

    if (!descriptionRaw) {
      logInvalidDescriptionResult(mediaId, mediaType, result)
      return
    }

    await prisma.media.update({
      where: { mediaId },
      data: { descriptionRaw: toDescriptionRawInput(descriptionRaw) },
    })
    logDescriptionGenerated(provider, 'describePdf', mediaId, startedAt, 'PDF 描述已生成')
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
