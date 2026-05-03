import { sendGroupReply, sendPrivateMessage as sendPrivateMessageRaw, type SendNapcatResult } from './napcat-sender.js'
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

  async sendGroupMessage(params: { groupId: number; text: string }): Promise<SendNapcatResult> {
    return sendGroupReply(params.groupId, [{ type: 'text', data: { text: params.text } }])
  }
}

export function createMessageSender(): MessageSender {
  return new NapcatMessageSender()
}

export const messageSender: MessageSender = createMessageSender()
