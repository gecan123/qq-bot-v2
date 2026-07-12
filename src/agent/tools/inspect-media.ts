import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { ToolResultContentBlock } from '../agent-context.types.js'
import { imageHandleSchema, type ImageHandle, type ResolvedImage } from '../../media/image-handle-schema.js'
import { resolveImageHandle, releaseHandle } from '../../media/image-handle.js'
import { compressForContext, type CompressedImage } from '../../media/compress-for-context.js'
import { generateDescriptionForMedia } from '../../jobs/generate-description.js'
import { getMediaDescriptionText } from '../../media/media-description.js'
import { prisma } from '../../database/client.js'
import { waitForPendingMediaDownloads } from '../../media/media-cache.js'
import { config } from '../../config/index.js'
import { createLogger } from '../../logger.js'
import { createTaskScheduler, type TaskScheduler } from '../task-scheduler.js'

const log = createLogger('TOOL_INSPECT_MEDIA')

const argsSchema = z.object({
  image: imageHandleSchema.describe('要查看的图片句柄. 入站图片传 {mediaId}; 临时生成图传 {ephemeralRef}.'),
})

type Args = z.infer<typeof argsSchema>

interface MediaMetadata {
  mediaType: string | null
  descriptionRaw: unknown
}

export interface InspectMediaDeps {
  resolveImage?: (handle: ImageHandle, opts?: { acquire?: boolean }) => Promise<ResolvedImage>
  describeMedia?: (mediaId: number) => Promise<void>
  waitForMedia?: (mediaId: number) => Promise<void>
  loadMediaMetadata?: (mediaId: number) => Promise<MediaMetadata | null>
  compress?: (bytes: Buffer) => Promise<CompressedImage | null>
  taskScheduler?: TaskScheduler
}

async function loadMediaMetadata(mediaId: number): Promise<MediaMetadata | null> {
  return prisma.media.findUnique({
    where: { mediaId },
    select: { mediaType: true, descriptionRaw: true },
  })
}

export function createInspectMediaTool(deps: InspectMediaDeps = {}): Tool<Args> {
  const resolveImage = deps.resolveImage ?? resolveImageHandle
  const describeMedia = deps.describeMedia ?? generateDescriptionForMedia
  const waitForMedia = deps.waitForMedia ?? ((mediaId: number) => (
    waitForPendingMediaDownloads([mediaId], config.replyMediaTimeoutMs)
  ))
  const loadMetadata = deps.loadMediaMetadata ?? loadMediaMetadata
  const compress = deps.compress ?? compressForContext
  const taskScheduler = deps.taskScheduler ?? createTaskScheduler({ 'media-description': { concurrency: 1 } })

  return {
    name: 'inspect_media',
    description: [
      '主动查看一张已有图片, 返回有界文字描述和真实图片预览 image block.',
      '当消息里的图片没有描述、描述超时、需要核对视觉细节, 或用户说“看一下这张图”时使用.',
      '真实图片预览优先立即返回; 缺失的文字描述会放入后台媒体 worker, 不阻塞当前工具结果.',
      '入站图片使用 inbox 返回的 mediaId; 生成图可使用 background_task 返回的 ephemeralRef.',
      '本工具只负责查看已有图片; 创作或改图使用 generate_image.',
    ].join(' '),
    schema: argsSchema,
    async execute({ image }) {
      let metadata: MediaMetadata | null = null
      let descriptionPending = false

      if ('mediaId' in image) {
        await waitForMedia(image.mediaId)
        metadata = await loadMetadata(image.mediaId)
        if (!metadata) {
          return errorResult('not_found', `Media not found: mediaId=${image.mediaId}`)
        }
        if (metadata.mediaType !== 'image' && metadata.mediaType !== 'sticker') {
          return errorResult('unsupported_media_type', `inspect_media only supports image/sticker, got ${metadata.mediaType ?? 'unknown'}`)
        }
        if (!getMediaDescriptionText(metadata.descriptionRaw)) {
          descriptionPending = true
          void taskScheduler.schedule({
            lane: 'media-description',
            resourceKey: `media:${image.mediaId}`,
            dedupeKey: `media-description:${image.mediaId}`,
          }, () => describeMedia(image.mediaId)).catch((error) => {
            log.warn({
              err: error,
              mediaId: image.mediaId,
            }, 'inspect_media_description_background_failed')
          })
        }
      }

      try {
        const resolved = await resolveImage(image, { acquire: true })
        if (resolved.byteSize === 0) {
          return errorResult('media_unavailable', '图片数据尚未下载完成或为空，请稍后重试。')
        }
        const preview = await compress(resolved.bytes)
        if (!preview) {
          return errorResult('preview_failed', '图片预览压缩失败，无法把图片放入当前上下文。')
        }

        const description = metadata
          ? getMediaDescriptionText(metadata.descriptionRaw)
          : resolved.description.trim() || null
        const blocks: ToolResultContentBlock[] = [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              imageRef: 'mediaId' in image ? `media:${image.mediaId}` : `ephemeral:${image.ephemeralRef}`,
              mediaType: metadata?.mediaType ?? 'image',
              contentType: resolved.contentType,
              byteSize: resolved.byteSize,
              description,
              descriptionStatus: description ? 'available' : descriptionPending ? 'pending' : 'unavailable',
              previewIncluded: true,
            }),
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: preview.mediaType, data: preview.base64 },
          },
        ]
        return { content: blocks }
      } catch (error) {
        return errorResult('resolve_failed', error instanceof Error ? error.message : String(error))
      } finally {
        releaseHandle(image)
      }
    },
  }
}

function errorResult(code: string, error: string): { content: string; outcome: { ok: false; code: string; error: string } } {
  return {
    content: JSON.stringify({ ok: false, code, error }),
    outcome: { ok: false, code, error },
  }
}
