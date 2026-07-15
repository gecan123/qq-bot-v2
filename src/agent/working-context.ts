import type {
  AgentMessage,
  DurableAgentMessage,
  ToolResultContentBlock,
  ToolResultImageRefBlock,
} from './agent-context.types.js'
import {
  agentImageRefStore,
  type AgentImageRefStore,
} from '../media/agent-image-ref.js'

const DEFAULT_RECENT_IMAGE_TOOL_RESULTS = 3

export interface WorkingContextOptions {
  /** Hydrate image refs only in this many most-recent tool-result messages. */
  recentImageToolResults?: number
  imageRefs?: AgentImageRefStore
}

export interface WorkingContextStats {
  sourceMessages: number
  projectedMessages: number
  hydratedImages: number
  omittedImages: number
  unavailableImages: number
}

export interface WorkingContextProjection {
  messages: AgentMessage[]
  stats: WorkingContextStats
}

/** Build a disposable LLM projection. Canonical messages remain stable refs. */
export async function buildWorkingContextProjection(
  source: readonly DurableAgentMessage[],
  options: WorkingContextOptions = {},
): Promise<WorkingContextProjection> {
  const recentImageToolResults = normalizeNonNegativeInteger(
    options.recentImageToolResults,
    DEFAULT_RECENT_IMAGE_TOOL_RESULTS,
  )
  const hydratedIndexes = findRecentImageToolResultIndexes(source, recentImageToolResults)
  const imageRefs = options.imageRefs ?? agentImageRefStore
  const stats: WorkingContextStats = {
    sourceMessages: source.length,
    projectedMessages: source.length,
    hydratedImages: 0,
    omittedImages: 0,
    unavailableImages: 0,
  }
  const messages: AgentMessage[] = []

  for (let index = 0; index < source.length; index++) {
    const message = source[index]!
    if (message.role !== 'tool' || typeof message.content === 'string') {
      messages.push(structuredClone(message))
      continue
    }
    const content: ToolResultContentBlock[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        content.push({ ...block })
        continue
      }
      if (block.type === 'image') {
        if (hydratedIndexes.has(index)) {
          stats.hydratedImages++
          content.push({ type: 'image', source: { ...block.source } })
        } else {
          stats.omittedImages++
          content.push({
            type: 'text',
            text: JSON.stringify({
              type: 'working_context_legacy_image_omitted',
              mediaType: block.source.media_type,
            }),
          })
        }
        continue
      }
      if (!hydratedIndexes.has(index)) {
        stats.omittedImages++
        content.push({ type: 'text', text: renderImageMarker('working_context_image_omitted', block) })
        continue
      }
      let hydrated = null
      try {
        hydrated = await imageRefs.resolve(block)
      } catch {
        // Missing/corrupt media is a projection concern and must not break replay.
      }
      if (hydrated == null) {
        stats.unavailableImages++
        content.push({
          type: 'text',
          text: renderImageMarker('working_context_image_unavailable', block),
        })
      } else {
        stats.hydratedImages++
        content.push(hydrated)
      }
    }
    messages.push({ role: 'tool', toolCallId: message.toolCallId, content })
  }

  return { messages, stats }
}

function findRecentImageToolResultIndexes(
  messages: readonly DurableAgentMessage[],
  limit: number,
): Set<number> {
  const indexes = new Set<number>()
  if (limit === 0) return indexes
  for (let index = messages.length - 1; index >= 0 && indexes.size < limit; index--) {
    const message = messages[index]
    if (
      message?.role === 'tool'
      && Array.isArray(message.content)
      && message.content.some((block) => block.type === 'image_ref' || block.type === 'image')
    ) {
      indexes.add(index)
    }
  }
  return indexes
}

function renderImageMarker(
  type: 'working_context_image_omitted' | 'working_context_image_unavailable',
  ref: ToolResultImageRefBlock,
): string {
  return JSON.stringify({
    type,
    mediaId: ref.mediaId,
    mediaType: ref.mediaType,
    ...(ref.width == null ? {} : { width: ref.width }),
    ...(ref.height == null ? {} : { height: ref.height }),
    ...(ref.description == null ? {} : { description: ref.description }),
  })
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}
