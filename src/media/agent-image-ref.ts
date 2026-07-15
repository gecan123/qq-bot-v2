import { prisma } from '../database/client.js'
import type {
  ToolResultImageBlock,
  ToolResultImageRefBlock,
} from '../agent/agent-context.types.js'
import { computeMediaHash } from './media-hash.js'
import { resolvePersistedImage } from './image-handle.js'

export interface AgentImageRefStore {
  persist(
    block: ToolResultImageBlock,
    metadata?: { description?: string; width?: number; height?: number },
  ): Promise<ToolResultImageRefBlock>
  resolve(ref: ToolResultImageRefBlock): Promise<ToolResultImageBlock | null>
}

export interface AgentImageRefPersistenceClient {
  media: {
    upsert(args: unknown): Promise<{ mediaId: number }>
    findUnique(args: unknown): Promise<{
      data: Uint8Array
      dataHash?: string | null
      contentType?: string | null
      descriptionRaw?: unknown
    } | null>
  }
}

export function createAgentImageRefStore(
  client: AgentImageRefPersistenceClient = prisma as unknown as AgentImageRefPersistenceClient,
): AgentImageRefStore {
  return {
    async persist(block, metadata = {}) {
      const bytes = decodeBase64(block.source.data)
      const dataHash = computeMediaHash(bytes)
      const row = await client.media.upsert({
        where: { dataHash },
        create: {
          data: new Uint8Array(bytes),
          dataHash,
          contentType: block.source.media_type,
          mediaType: 'image',
          fileSize: bytes.byteLength,
          ...(metadata.description == null ? {} : {
            descriptionRaw: { description: metadata.description, source: 'agent_tool_result' },
          }),
        },
        update: {},
        select: { mediaId: true },
      })
      return {
        type: 'image_ref',
        mediaId: String(row.mediaId),
        mediaType: block.source.media_type,
        ...(metadata.width == null ? {} : { width: metadata.width }),
        ...(metadata.height == null ? {} : { height: metadata.height }),
        ...(metadata.description == null ? {} : { description: metadata.description }),
      }
    },
    async resolve(ref) {
      const image = await resolvePersistedImage(ref.mediaId, client)
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
