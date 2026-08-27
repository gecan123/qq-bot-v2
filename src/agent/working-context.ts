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
import type { AgentImageMode } from '../config/index.js'

export interface WorkingContextOptions {
  /** Missing/description uses persisted vision text; native sends original images to the main model. */
  imageInputMode?: AgentImageMode
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
  const usesNativeImageInput = options.imageInputMode === 'native'
  const imageRefs = options.imageRefs ?? agentImageRefStore
  const stats: WorkingContextStats = {
    sourceMessages: source.length,
    projectedMessages: source.length,
    hydratedImages: 0,
    omittedImages: 0,
    unavailableImages: 0,
  }
  const messages: AgentMessage[] = []

  for (const message of source) {
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
        if (usesNativeImageInput) {
          stats.hydratedImages++
          content.push({ type: 'image', source: { ...block.source } })
        } else {
          stats.omittedImages++
          content.push({
            type: 'text',
            text: JSON.stringify({
              type: 'working_context_legacy_image_omitted',
              reason: 'agent_image_mode_description',
              mediaType: block.source.media_type,
            }),
          })
        }
        continue
      }
      if (!usesNativeImageInput) {
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

function renderImageMarker(
  type: 'working_context_image_omitted' | 'working_context_image_unavailable',
  ref: ToolResultImageRefBlock,
): string {
  return JSON.stringify({
    type,
    ...(type === 'working_context_image_omitted'
      ? { reason: 'agent_image_mode_description' }
      : {}),
    mediaId: ref.mediaId,
    mediaType: ref.mediaType,
    ...(ref.width == null ? {} : { width: ref.width }),
    ...(ref.height == null ? {} : { height: ref.height }),
    ...(ref.description == null ? {} : { description: ref.description }),
  })
}
