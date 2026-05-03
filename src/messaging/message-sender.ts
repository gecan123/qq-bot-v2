import { sendGroupReply, sendPrivateMessage, type SendNapcatResult } from './napcat-sender.js'
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
  }): Promise<SendNapcatResult>

  sendGroupMessage(params: {
    groupId: number
    text: string
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

  async sendPrivateMessage(params: { userId: number; text: string }): Promise<SendNapcatResult> {
    return sendPrivateMessage(params.userId, [{ type: 'text', data: { text: params.text } }])
  }

  async sendGroupMessage(params: { groupId: number; text: string }): Promise<SendNapcatResult> {
    return sendGroupReply(params.groupId, [{ type: 'text', data: { text: params.text } }])
  }
}

export function createMessageSender(): MessageSender {
  return new NapcatMessageSender()
}

export const messageSender: MessageSender = createMessageSender()
