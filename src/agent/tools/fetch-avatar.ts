import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { ToolResultContentBlock } from '../agent-context.types.js'
import { config } from '../../config/index.js'
import { getOutboundCache } from '../../media/outbound-cache.js'
import { computeMediaHash } from '../../media/media-hash.js'
import { compressForContext } from '../../media/compress-for-context.js'
import type { ImageProduceResult } from '../../media/image-handle-schema.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_FETCH_AVATAR')

const AVATAR_BASE_URL = 'https://q1.qlogo.cn/g'

const argsSchema = z.object({
  qq: z
    .number()
    .int()
    .positive()
    .describe('目标用户的 QQ 号'),
  size: z
    .enum(['640', '100', '40'])
    .default('640')
    .describe('头像尺寸: 640(大图), 100(中图), 40(小图)'),
})

type Args = z.infer<typeof argsSchema>

export interface FetchAvatarDeps {
  fetcher?: typeof fetch
  timeoutMs?: number
}

function fail(error: string): { content: string } {
  return { content: JSON.stringify({ ok: false, error }) }
}

export function createFetchAvatarTool(deps: FetchAvatarDeps = {}): Tool<Args> {
  const fetcher = deps.fetcher ?? fetch
  const timeoutMs = deps.timeoutMs ?? config.fetchUrlTimeoutMs

  return {
    name: 'fetch_avatar',
    description:
      '通过 QQ 号获取用户头像图片. 图片会加入你的上下文, 你能直接看到; 同时返回 ephemeralRef 供后续任意操作: 发送、编辑、二创、理解对方形象等.',
    schema: argsSchema,
    async execute(rawArgs, _ctx) {
      const args = rawArgs as Args
      const url = `${AVATAR_BASE_URL}?b=qq&nk=${args.qq}&s=${args.size}`

      let response: Response
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        response = await fetcher(url, {
          signal: controller.signal,
          redirect: 'follow',
        })
      } catch (err) {
        clearTimeout(timer)
        const aborted = err instanceof Error && err.name === 'AbortError'
        log.warn({ qq: args.qq, error: aborted ? 'timeout' : 'network' }, 'fetch_avatar_failed')
        return fail(aborted ? `获取头像超时 (${timeoutMs}ms)` : '网络错误')
      }
      clearTimeout(timer)

      if (response.status < 200 || response.status >= 300) {
        return fail(`HTTP ${response.status}`)
      }

      const ab = await response.arrayBuffer()
      const bytes = Buffer.from(ab)

      if (bytes.byteLength === 0) {
        return fail('返回空图片')
      }

      const rawCt = response.headers.get('content-type') ?? 'image/jpeg'
      const contentType = rawCt.split(';')[0].trim().toLowerCase()
      const dataHash = computeMediaHash(bytes)
      const description = `QQ avatar of ${args.qq} (${args.size}px)`

      const cache = getOutboundCache()
      cache.put({ bytes, dataHash, byteSize: bytes.byteLength, contentType, description })

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
