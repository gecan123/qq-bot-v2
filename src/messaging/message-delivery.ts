import type { ChatPlatform, ConversationRef } from '../chat/conversation.js'

export type DeliveryStatus = 'sent' | 'failed' | 'delivery_unknown'

export interface DeliveryRequest {
  actionId: string
  target: ConversationRef
  text?: string
  imageBytes?: Buffer
  filePath?: string
  replyToExternalId?: string
  mentionExternalId?: string
  platformPayload?: unknown
}

export interface DeliveryResult {
  status: DeliveryStatus
  providerMessageId?: string
  code?: string
  error?: string
}

export interface PlatformDeliveryAdapter {
  platform: ChatPlatform
  send(request: DeliveryRequest): Promise<DeliveryResult>
}

export interface MessageDelivery {
  send(request: DeliveryRequest): Promise<DeliveryResult>
}

export function createMessageDelivery(adapters: PlatformDeliveryAdapter[]): MessageDelivery {
  const byPlatform = new Map(adapters.map((adapter) => [adapter.platform, adapter]))

  return {
    async send(request) {
      const adapter = byPlatform.get(request.target.platform)
      if (!adapter) {
        return {
          status: 'failed',
          code: 'channel_unavailable',
          error: `No delivery adapter registered for ${request.target.platform}`,
        }
      }
      try {
        return await adapter.send(request)
      } catch (error) {
        return {
          status: 'delivery_unknown',
          code: 'adapter_exception',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
