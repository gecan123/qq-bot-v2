import {
  sendGroupReply,
  sendPrivateMessage as sendPrivateMessageRaw,
  sendSegmentsRaw,
  type SendNapcatResult,
  type NapcatSegment,
  type SendTarget,
} from './napcat-sender.js'
import { buildReplySegments } from './segment-builder.js'

export interface MessageSender {
  replyToMessage(params: {
    groupId: number
    replyToMessageId: number
    mentionUserId?: number
    text: string
  }): Promise<SendNapcatResult>

  sendPrivateMessage(params: {
    userId: number
    text: string
    /** 可选: 引用某条历史私聊消息. NapCat 私聊 reply 与群 reply 同 segment 形式. */
    replyToMessageId?: number
  }): Promise<SendNapcatResult>

  sendGroupMessage(params: {
    groupId: number
    text: string
    mentionUserId?: number
  }): Promise<SendNapcatResult>

  sendSegments(params: {
    target: SendTarget
    segments: NapcatSegment[]
  }): Promise<SendNapcatResult>
}

class NapcatMessageSender implements MessageSender {
  async replyToMessage(params: {
    groupId: number
    replyToMessageId: number
    mentionUserId?: number
    text: string
  }): Promise<SendNapcatResult> {
    return sendGroupReply(
      params.groupId,
      buildReplySegments({
        replyToMessageId: params.replyToMessageId,
        mentionUserId: params.mentionUserId,
        text: params.text,
      }),
    )
  }

  async sendPrivateMessage(params: { userId: number; text: string; replyToMessageId?: number }): Promise<SendNapcatResult> {
    if (params.replyToMessageId !== undefined) {
      return sendPrivateMessageRaw(
        params.userId,
        buildReplySegments({
          replyToMessageId: params.replyToMessageId,
          text: params.text,
        }),
      )
    }
    return sendPrivateMessageRaw(params.userId, [{ type: 'text', data: { text: params.text } }])
  }

  async sendGroupMessage(params: { groupId: number; text: string; mentionUserId?: number }): Promise<SendNapcatResult> {
    const segments: NapcatSegment[] = []
    if (params.mentionUserId !== undefined) {
      segments.push({ type: 'at', data: { qq: String(params.mentionUserId) } })
    }
    const text = params.mentionUserId !== undefined ? ` ${params.text}` : params.text
    segments.push({ type: 'text', data: { text } })
    return sendGroupReply(params.groupId, segments)
  }

  async sendSegments(params: { target: SendTarget; segments: NapcatSegment[] }): Promise<SendNapcatResult> {
    return sendSegmentsRaw(params.target, params.segments)
  }
}

export function createMessageSender(): MessageSender {
  return new NapcatMessageSender()
}

export const messageSender: MessageSender = createMessageSender()
