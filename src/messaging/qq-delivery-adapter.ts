import type { MessageSender } from './message-sender.js'
import type { DeliveryRequest, PlatformDeliveryAdapter } from './message-delivery.js'
import { buildOutboundSegments, type MusicShare } from './segment-builder.js'

export function createQqDeliveryAdapter(sender: MessageSender): PlatformDeliveryAdapter {
  return {
    platform: 'qq',
    async send(request) {
      const target = qqTarget(request)
      if (!target) {
        return {
          status: 'failed',
          code: 'invalid_target',
          error: 'QQ conversation identifiers must be positive integers',
        }
      }
      const replyToMessageId = positiveInteger(request.replyToExternalId)
      const mentionUserId = positiveInteger(request.mentionExternalId)
      if (request.replyToExternalId != null && replyToMessageId == null) {
        return {
          status: 'failed',
          code: 'invalid_reply_id',
          error: 'QQ reply identifier must be a positive integer',
        }
      }
      if (request.mentionExternalId != null && mentionUserId == null) {
        return {
          status: 'failed',
          code: 'invalid_mention_id',
          error: 'QQ mention identifier must be a positive integer',
        }
      }
      const result = await sender.sendSegments({
        target,
        segments: buildOutboundSegments({
          ...(replyToMessageId == null ? {} : { replyToMessageId }),
          ...(mentionUserId == null ? {} : { mentionUserId }),
          ...(request.text == null ? {} : { text: request.text }),
          ...(request.imageBytes == null ? {} : { imageBytes: request.imageBytes }),
          ...(isMusicShare(request.platformPayload) ? { music: request.platformPayload } : {}),
        }),
      })
      return result.success
        ? {
            status: 'sent',
            ...(result.providerMessageId == null
              ? {}
              : { providerMessageId: String(result.providerMessageId) }),
          }
        : { status: 'failed', code: 'send_failed', error: 'QQ gateway send failed' }
    },
  }
}

function qqTarget(request: DeliveryRequest) {
  const id = positiveInteger(request.target.externalId)
  if (id == null) return null
  return request.target.kind === 'group'
    ? { type: 'group' as const, groupId: id }
    : { type: 'private' as const, userId: id }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value == null || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function isMusicShare(value: unknown): value is MusicShare {
  return typeof value === 'object' && value !== null && 'platform' in value
}
