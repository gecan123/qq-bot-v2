import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { ToolResultContentBlock } from '../agent-context.types.js'
import { config } from '../../config/index.js'
import { logFetch } from '../../ops/fetch-log.js'
import { getOutboundCache } from '../../media/outbound-cache.js'
import { computeMediaHash } from '../../media/media-hash.js'
import { compressForContext } from '../../media/compress-for-context.js'
import type { ImageProduceResult } from '../../media/image-handle-schema.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_DOWNLOAD_IMAGE')

const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])
const DEFAULT_USER_AGENT =
  'qq-bot-v2/0.1 (+https://github.com/anonymous; download-image)'

const argsSchema = z.object({
  url: z
    .string()
    .url()
    .describe('图片 URL (jpg/png/gif/webp). 从 reddit / 网页拿到的图片直链.'),
})

type Args = z.infer<typeof argsSchema>

export interface DownloadImageDeps {
  fetcher?: typeof fetch
  timeoutMs?: number
  userAgent?: string
  logPath?: string
  appender?: (path: string, line: string) => Promise<void>
  now?: () => Date
}

function extractBasename(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const segments = pathname.split('/')
    const last = segments[segments.length - 1] || ''
    return last.slice(0, 100) || 'image'
  } catch {
    return 'image'
  }
}

function parseContentType(raw: string): string {
  return raw.split(';')[0].trim().toLowerCase()
}

function fail(error: string): { content: string } {
  return { content: JSON.stringify({ ok: false, error }) }
}

export function createDownloadImageTool(
  deps: DownloadImageDeps = {},
): Tool<Args> {
  const fetcher = deps.fetcher ?? fetch
  const timeoutMs = deps.timeoutMs ?? config.fetchUrlTimeoutMs
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT
  const now = deps.now ?? (() => new Date())

  return {
    name: 'download_image',
    description: [
      '从 URL 下载一张图片, 返回 ephemeralRef.',
      '支持 jpg/png/gif/webp, 上限 10MB.',
      '拿到 ephemeralRef 后可传给 send_message 发送, 或传给 generate_image 编辑.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = rawArgs as Args
      const startedAt = Date.now()

      const baseLog = {
        ts: now().toISOString(),
        source: 'download_image',
        url: args.url,
        toolCallId: `round-${ctx.roundIndex}`,
      }

      let response: Response
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        response = await fetcher(args.url, {
          headers: { 'user-agent': userAgent, accept: 'image/*' },
          signal: controller.signal,
          redirect: 'follow',
        })
      } catch (err) {
        clearTimeout(timer)
        const durationMs = Date.now() - startedAt
        const aborted = err instanceof Error && err.name === 'AbortError'
        const errorKind = aborted ? 'timeout' : 'network_error'
        await logFetch(
          { ...baseLog, status: -1, bytes: 0, durationMs, errorKind },
          { path: deps.logPath, appender: deps.appender },
        )
        log.warn({ url: args.url, errorKind }, 'download_image_failed')
        return fail(
          aborted
            ? `下载超时 (${timeoutMs}ms): ${args.url}`
            : `网络错误: ${args.url}`,
        )
      }

      clearTimeout(timer)

      if (response.status < 200 || response.status >= 300) {
        const durationMs = Date.now() - startedAt
        await logFetch(
          {
            ...baseLog,
            status: response.status,
            bytes: 0,
            durationMs,
            errorKind: `http_${response.status}`,
          },
          { path: deps.logPath, appender: deps.appender },
        )
        return fail(`HTTP ${response.status}: ${args.url}`)
      }

      const rawContentType = response.headers.get('content-type') ?? ''
      const contentType = parseContentType(rawContentType)

      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        const durationMs = Date.now() - startedAt
        await logFetch(
          {
            ...baseLog,
            status: response.status,
            bytes: 0,
            durationMs,
            errorKind: 'bad_content_type',
          },
          { path: deps.logPath, appender: deps.appender },
        )
        return fail(
          `不支持的 content-type: ${contentType}. 只接受 ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
        )
      }

      let bytes: Buffer
      if (!response.body) {
        const ab = await response.arrayBuffer()
        bytes = Buffer.from(ab).subarray(0, IMAGE_MAX_BYTES)
      } else {
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value || value.byteLength === 0) continue
            chunks.push(value)
            total += value.byteLength
            if (total >= IMAGE_MAX_BYTES) {
              await reader.cancel().catch(() => {})
              break
            }
          }
        } finally {
          reader.releaseLock?.()
        }
        const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)))
        bytes =
          merged.byteLength > IMAGE_MAX_BYTES
            ? merged.subarray(0, IMAGE_MAX_BYTES)
            : merged
      }

      const durationMs = Date.now() - startedAt
      const dataHash = computeMediaHash(bytes)
      const description = `Downloaded: ${extractBasename(args.url)}`

      const cache = getOutboundCache()
      cache.put({
        bytes,
        dataHash,
        byteSize: bytes.byteLength,
        contentType,
        description,
      })

      await logFetch(
        {
          ...baseLog,
          status: response.status,
          bytes: bytes.byteLength,
          durationMs,
        },
        { path: deps.logPath, appender: deps.appender },
      )

      const result: ImageProduceResult = {
        ephemeralRef: dataHash,
        dataHash,
        byteSize: bytes.byteLength,
        contentType,
        description,
      }

      const compressed = await compressForContext(bytes)
      const blocks: ToolResultContentBlock[] = [
        { type: 'text', text: JSON.stringify({ ok: true, ...result }) },
      ]
      if (compressed) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: compressed.mediaType, data: compressed.base64 },
        })
      }

      return { content: blocks }
    },
  }
}
