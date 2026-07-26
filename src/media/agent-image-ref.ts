import type {
  ToolResultImageBlock,
  ToolResultImageRefBlock,
} from '../agent/agent-context.types.js'
import { computeMediaHash } from './media-hash.js'
import { resolvePersistedImage, type PersistedImageResolver } from './image-handle.js'
import { promoteToMedia, type PromoteInput } from './promote-outbound.js'

export interface AgentImageRefStore {
  persist(
    block: ToolResultImageBlock,
    metadata?: { description?: string; width?: number; height?: number },
  ): Promise<ToolResultImageRefBlock>
  resolve(ref: ToolResultImageRefBlock): Promise<ToolResultImageBlock | null>
}

export interface AgentImageRefPersistence {
  promote(input: PromoteInput): Promise<number>
  resolve: PersistedImageResolver
}

export function createAgentImageRefStore(
  persistence: AgentImageRefPersistence = {
    promote: promoteToMedia,
    resolve: resolvePersistedImage,
  },
): AgentImageRefStore {
  return {
    async persist(block, metadata = {}) {
      const bytes = decodeBase64(block.source.data)
      const dataHash = computeMediaHash(bytes)
      const mediaId = await persistence.promote({
        bytes,
        dataHash,
        contentType: block.source.media_type,
        mediaType: 'image',
        description: metadata.description,
        descriptionSource: 'agent_tool_result',
      })
      return {
        type: 'image_ref',
        mediaId: String(mediaId),
        mediaType: block.source.media_type,
        ...(metadata.width == null ? {} : { width: metadata.width }),
        ...(metadata.height == null ? {} : { height: metadata.height }),
        ...(metadata.description == null ? {} : { description: metadata.description }),
      }
    },
    async resolve(ref) {
      const image = await persistence.resolve(ref.mediaId)
      if (!image) return null
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.contentType || ref.mediaType,
          data: image.bytes.toString('base64'),
        },
      }
    },
  }
}

export const agentImageRefStore = createAgentImageRefStore()

function decodeBase64(value: string): Buffer {
  if (value.length === 0) throw new Error('tool image base64 data must not be empty')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0) throw new Error('tool image base64 data is invalid')
  return bytes
}
