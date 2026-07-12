import type {
  AgentMessage,
  ToolResultContentBlock,
  ToolResultImageBlock,
} from './agent-context.types.js'

const DEFAULT_RECENT_IMAGE_TOOL_RESULTS = 3

export interface WorkingContextOptions {
  /** 从 ledger 尾部保留完整图片的 tool-result 消息数；更早图片只在投影中替换为稳定文本。 */
  recentImageToolResults?: number
}

export interface WorkingContextStats {
  sourceMessages: number
  projectedMessages: number
  preservedImages: number
  omittedImages: number
  omittedBase64Chars: number
}

export interface WorkingContextProjection {
  messages: AgentMessage[]
  stats: WorkingContextStats
}

/**
 * 从 durable AgentContext 构造单次 LLM 请求的可重建投影。
 *
 * 它不删 message、不改 role、不拆 tool call/result，只降级较旧 tool result 中的图片字节。
 * 因而 snapshot/replay 仍保存原始事实，working context 可以在每轮从 ledger 确定性重建。
 */
export function buildWorkingContextProjection(
  source: readonly AgentMessage[],
  options: WorkingContextOptions = {},
): WorkingContextProjection {
  const recentImageToolResults = normalizeNonNegativeInteger(
    options.recentImageToolResults,
    DEFAULT_RECENT_IMAGE_TOOL_RESULTS,
  )
  const preservedImageMessageIndexes = findRecentImageToolResultIndexes(
    source,
    recentImageToolResults,
  )
  const stats: WorkingContextStats = {
    sourceMessages: source.length,
    projectedMessages: source.length,
    preservedImages: 0,
    omittedImages: 0,
    omittedBase64Chars: 0,
  }

  const messages = source.map((message, index): AgentMessage => {
    if (message.role !== 'tool' || typeof message.content === 'string') {
      return structuredClone(message)
    }

    const preserveImages = preservedImageMessageIndexes.has(index)
    const content = message.content.map((block): ToolResultContentBlock => {
      if (block.type !== 'image') return { ...block }
      if (preserveImages) {
        stats.preservedImages++
        return cloneImageBlock(block)
      }

      stats.omittedImages++
      stats.omittedBase64Chars += block.source.data.length
      return {
        type: 'text',
        text: renderOmittedImageMarker(block),
      }
    })
    return { role: 'tool', toolCallId: message.toolCallId, content }
  })

  return { messages, stats }
}

function findRecentImageToolResultIndexes(
  messages: readonly AgentMessage[],
  limit: number,
): Set<number> {
  const indexes = new Set<number>()
  if (limit === 0) return indexes

  for (let index = messages.length - 1; index >= 0 && indexes.size < limit; index--) {
    const message = messages[index]
    if (
      message?.role === 'tool'
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === 'image')
    ) {
      indexes.add(index)
    }
  }
  return indexes
}

function cloneImageBlock(block: ToolResultImageBlock): ToolResultImageBlock {
  return {
    type: 'image',
    source: { ...block.source },
  }
}

function renderOmittedImageMarker(block: ToolResultImageBlock): string {
  return JSON.stringify({
    type: 'working_context_image_omitted',
    mediaType: block.source.media_type,
    base64Chars: block.source.data.length,
    durableLedgerRetainsOriginal: true,
  })
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}
