import type {
  AgentMessage,
  DurableAgentMessage,
  DurableToolResultContentBlock,
  ToolResultContentBlock,
} from './agent-context.types.js'
import {
  agentImageRefStore,
  type AgentImageRefStore,
} from '../media/agent-image-ref.js'

export async function toDurableAgentMessage(
  message: AgentMessage,
  imageRefs: AgentImageRefStore = agentImageRefStore,
): Promise<DurableAgentMessage> {
  if (message.role !== 'tool' || typeof message.content === 'string') {
    return structuredClone(message)
  }
  const description = findPersistedDescription(message.content)
  const content: DurableToolResultContentBlock[] = []
  for (const block of message.content) {
    if (block.type === 'image') {
      content.push(await imageRefs.persist(block, description == null ? {} : { description }))
    } else if (block.type === 'image_ref') {
      content.push({ ...block })
    } else {
      content.push({ ...block })
    }
  }
  return { role: 'tool', toolCallId: message.toolCallId, content }
}

function findPersistedDescription(
  content: readonly ToolResultContentBlock[],
): string | null {
  for (const block of content) {
    if (block.type !== 'text') continue
    const text = block.text.trim()
    if (!text) continue
    try {
      const parsed = JSON.parse(text) as unknown
      if (
        parsed != null
        && typeof parsed === 'object'
        && 'description' in parsed
        && typeof parsed.description === 'string'
        && parsed.description.trim()
      ) {
        return parsed.description.trim().slice(0, 2_000)
      }
    } catch {
      // A plain-text tool result is still useful fallback metadata.
    }
    return text.slice(0, 2_000)
  }
  return null
}
