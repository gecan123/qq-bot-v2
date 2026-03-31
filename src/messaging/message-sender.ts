import { sendGroupReply } from '../responder/reply-executor.js'
import { buildReplySegments } from './segment-builder.js'

export interface MessageSender {
  replyToMessage(params: {
    groupId: number
    replyToMessageId: number
    mentionUserId?: number
    text: string
  }): Promise<void>
}

class NapcatMessageSender implements MessageSender {
  async replyToMessage(params: {
    groupId: number
    replyToMessageId: number
    mentionUserId?: number
    text: string
  }): Promise<void> {
    await sendGroupReply(
      params.groupId,
      buildReplySegments({
        replyToMessageId: params.replyToMessageId,
        mentionUserId: params.mentionUserId,
        text: params.text,
      }),
    )
  }
}

export const messageSender: MessageSender = new NapcatMessageSender()

