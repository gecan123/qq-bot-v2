import { spawn } from 'node:child_process'
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

const log = createLogger('TOOL_FETCH_IMAGE')

const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const CURL_STDOUT_CAP_BYTES = IMAGE_MAX_BYTES + 8192
const DEFAULT_USER_AGENT = 'qq-bot-v2/0.1 (+https://github.com/anonymous; fetch-image)'
const AVATAR_BASE_URL = 'https://q1.qlogo.cn/g'
const CURL_META_MARKER = '\n__QQ_BOT_FETCH_IMAGE_META__'
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('url').describe('从图片 URL 下载图片.'),
    url: z.string().url().describe('图片 URL (jpg/png/gif/webp).'),
  }),
  z.object({
    action: z.literal('qq_avatar').describe('通过 QQ 号获取用户头像图片.'),
    qq: z.number().int().positive().describe('目标用户的 QQ 号.'),
    size: z.enum(['640', '100', '40']).default('640').describe('头像尺寸: 640(大图), 100(中图), 40(小图).'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface CurlImageResult {
  status: number
  contentType: string
  bytes: Buffer
  durationMs: number
  errorKind?: string
  error?: string
}

export type CurlImageRunner = (url: string, options: CurlImageOptions) => Promise<CurlImageResult>

export interface CurlImageOptions {
  timeoutMs: number
  maxBytes: number
  userAgent: string
}

export interface FetchImageDeps {
  curl?: CurlImageRunner
  timeoutMs?: number
  userAgent?: string
  logPath?: string
  appender?: (path: string, line: string) => Promise<void>
  now?: () => Date
}

function parseContentType(raw: string): string {
  return raw.split(';')[0].trim().toLowerCase()
}

function fail(error: string): { content: string } {
  return { content: JSON.stringify({ ok: false, error }) }
}

function buildUrl(args: Args): { url: string; description: string; source: 'url' | 'qq_avatar' } {
  if (args.action === 'url') {
    return { url: args.url, description: `Fetched image: ${extractBasename(args.url)}`, source: 'url' }
  }
  const size = args.size ?? '640'
  return {
    url: `${AVATAR_BASE_URL}?b=qq&nk=${args.qq}&s=${size}`,
    description: `QQ avatar of ${args.qq} (${size}px)`,
    source: 'qq_avatar',
  }
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

export function createFetchImageTool(deps: FetchImageDeps = {}): Tool<Args> {
  const curl = deps.curl ?? runCurlImage
  const timeoutMs = deps.timeoutMs ?? config.fetchUrlTimeoutMs
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT
  const now = deps.now ?? (() => new Date())

  return {
    name: 'fetch_image',
    description: [
      '获取图片并返回 ephemeralRef, 一个入口用 action 决定来源.',
      'action=url: 从图片 URL 下载 jpg/png/gif/webp, 支持后续 send_message 发送、generate_image 编辑或 collect_sticker 收藏.',
      'action=qq_avatar: 通过 QQ 号获取用户头像, 图片会进入上下文并返回 ephemeralRef.',
      '实现内部通过受限 curl 子进程抓取 bytes; 不要用 workspace_bash/curl 绕过本工具.',
      '本工具会处理大小限制、图片预览、OutboundCache 和审计日志; 成功时图片预览会作为 image block 进入上下文.',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      const { url, description, source } = buildUrl(args)
      const startedAt = Date.now()
      const baseLog = {
        ts: now().toISOString(),
        source: 'fetch_image',
        url,
        toolCallId: `round-${ctx.roundIndex}`,
      }

      const outcome = await curl(url, { timeoutMs, maxBytes: IMAGE_MAX_BYTES, userAgent })
      const durationMs = outcome.durationMs || Date.now() - startedAt

      if (outcome.errorKind) {
        await logFetch(
          { ...baseLog, status: outcome.status, bytes: outcome.bytes.byteLength, durationMs, errorKind: outcome.errorKind },
          { path: deps.logPath, appender: deps.appender },
        )
        log.warn({ url, source, errorKind: outcome.errorKind, error: outcome.error }, 'fetch_image_failed')
        return fail(outcome.error ?? `图片获取失败: ${outcome.errorKind}`)
      }

      if (outcome.status < 200 || outcome.status >= 300) {
        await logFetch(
          { ...baseLog, status: outcome.status, bytes: 0, durationMs, errorKind: `http_${outcome.status}` },
          { path: deps.logPath, appender: deps.appender },
        )
        return fail(`HTTP ${outcome.status}: ${url}`)
      }

      const contentType = parseContentType(outcome.contentType)
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        await logFetch(
          { ...baseLog, status: outcome.status, bytes: 0, durationMs, errorKind: 'bad_content_type' },
          { path: deps.logPath, appender: deps.appender },
        )
        return fail(`不支持的 content-type: ${contentType}. 只接受 ${[...ALLOWED_CONTENT_TYPES].join(', ')}`)
      }

      if (outcome.bytes.byteLength === 0) {
        await logFetch(
          { ...baseLog, status: outcome.status, bytes: 0, durationMs, errorKind: 'empty_image' },
          { path: deps.logPath, appender: deps.appender },
        )
        return fail('返回空图片')
      }

      const bytes = outcome.bytes.byteLength > IMAGE_MAX_BYTES
        ? outcome.bytes.subarray(0, IMAGE_MAX_BYTES)
        : outcome.bytes
      const dataHash = computeMediaHash(bytes)
      getOutboundCache().put({
        bytes,
        dataHash,
        byteSize: bytes.byteLength,
        contentType,
        description,
      })

      await logFetch(
        { ...baseLog, status: outcome.status, bytes: bytes.byteLength, durationMs },
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

export async function runCurlImage(url: string, options: CurlImageOptions): Promise<CurlImageResult> {
  const startedAt = Date.now()
  const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000))
  const args = [
    '--location',
    '--silent',
    '--show-error',
    '--proto',
    '=http,https',
    '--proto-redir',
    '=http,https',
    '--max-time',
    String(timeoutSeconds),
    '--max-filesize',
    String(options.maxBytes),
    '--user-agent',
    options.userAgent,
    '--header',
    'Accept: image/*',
    '--output',
    '-',
    '--write-out',
    `${CURL_META_MARKER}%{http_code}\n%{content_type}`,
    url,
  ]

  return await new Promise<CurlImageResult>((resolve) => {
    const child = spawn('curl', args, { shell: false, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
    const chunks: Buffer[] = []
    const stderr: Buffer[] = []
    let total = 0
    let killedForSize = false
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, options.timeoutMs + 1000)

    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > CURL_STDOUT_CAP_BYTES) {
        killedForSize = true
        child.kill('SIGTERM')
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderr).byteLength < 4096) stderr.push(chunk)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        status: -1,
        contentType: '',
        bytes: Buffer.alloc(0),
        durationMs: Date.now() - startedAt,
        errorKind: 'spawn_error',
        error: `curl 启动失败: ${err.message}`,
      })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const durationMs = Date.now() - startedAt
      if (killedForSize) {
        resolve({
          status: -1,
          contentType: '',
          bytes: Buffer.alloc(0),
          durationMs,
          errorKind: 'too_large',
          error: `图片超过大小上限 (${options.maxBytes} bytes)`,
        })
        return
      }
      const output = Buffer.concat(chunks)
      const parsed = parseCurlOutput(output)
      if (!parsed) {
        const errText = Buffer.concat(stderr).toString('utf8').trim()
        resolve({
          status: code ?? -1,
          contentType: '',
          bytes: Buffer.alloc(0),
          durationMs,
          errorKind: signal ? 'timeout' : 'curl_error',
          error: signal ? `curl 超时 (${options.timeoutMs}ms)` : `curl 失败: ${errText || `exit ${code}`}`,
        })
        return
      }
      if (code !== 0 && parsed.status < 200) {
        const errText = Buffer.concat(stderr).toString('utf8').trim()
        resolve({
          ...parsed,
          durationMs,
          errorKind: signal ? 'timeout' : 'curl_error',
          error: signal ? `curl 超时 (${options.timeoutMs}ms)` : `curl 失败: ${errText || `exit ${code}`}`,
        })
        return
      }
      resolve({ ...parsed, durationMs })
    })
  })
}

function parseCurlOutput(output: Buffer): Omit<CurlImageResult, 'durationMs'> | null {
  const marker = Buffer.from(CURL_META_MARKER)
  const idx = output.lastIndexOf(marker)
  if (idx < 0) return null
  const bytes = output.subarray(0, idx)
  const meta = output.subarray(idx + marker.byteLength).toString('utf8')
  const [statusLine = '', contentTypeLine = ''] = meta.split('\n')
  const status = Number(statusLine.trim())
  if (!Number.isInteger(status)) return null
  return {
    status,
    contentType: contentTypeLine.trim(),
    bytes,
  }
}

export const fetchImageTool = createFetchImageTool()
