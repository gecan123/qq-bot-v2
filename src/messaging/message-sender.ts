import { sendGroupReply, sendPrivateMessage, type SendGroupReplyResult } from '../responder/reply-executor.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { buildReplySegments } from './segment-builder.js'
import { previewText } from '../utils/business-log.js'

const log = createLogger('MESSAGE_SENDER')

export interface MessageSender {
  isReplyDryRunEnabled?(): boolean

  replyToMessage(params: {
    groupId: number
    replyToMessageId: number
    mentionUserId?: number
    text: string
  }): Promise<SendGroupReplyResult>

  sendPrivateMessage?(params: {
    userId: number
    text: string
  }): Promise<SendGroupReplyResult>

  /**
   * 主动群发(无 anchor message)。区别于 replyToMessage:不带 replyToMessageId,
   * 不引用任何用户消息。给 ActionType: 'send_group_message' 用。
   */
  sendGroupMessage?(params: {
    groupId: number
    text: string
  }): Promise<SendGroupReplyResult>
}

export interface MessageSenderOptions {
  replyDryRun?: boolean
  sendGroupReplyFn?: typeof sendGroupReply
  sendPrivateMessageFn?: typeof sendPrivateMessage
}

class NapcatMessageSender implements MessageSender {
  constructor(private readonly options: Required<MessageSenderOptions>) {}

  isReplyDryRunEnabled(): boolean {
    return this.options.replyDryRun
  }

  async replyToMessage(params: {
    groupId: number
    replyToMessageId: number
    mentionUserId?: number
    text: string
  }): Promise<SendGroupReplyResult> {
    if (this.options.replyDryRun) {
      log.info(
        {
          direction: 'outbound',
          actor: 'bot',
          category: 'reply_delivery',
          flow: 'napcat_send_dry_run',
          groupId: params.groupId,
          replyToMessageId: params.replyToMessageId,
          mentionUserId: params.mentionUserId,
          deliveryType: 'reply_to_message',
          dispatchMode: 'dry_run',
          sideEffect: 'none',
          deliveryResult: 'dry_run',
          textPreview: previewText(params.text),
        },
        '回复发送跳过（dry run）',
      )
      return { success: true, attempts: 0 }
    }

    return this.options.sendGroupReplyFn(
      params.groupId,
      buildReplySegments({
        replyToMessageId: params.replyToMessageId,
        mentionUserId: params.mentionUserId,
        text: params.text,
      }),
    )
  }

  async sendPrivateMessage(params: { userId: number; text: string }): Promise<SendGroupReplyResult> {
    if (this.options.replyDryRun) {
      log.info(
        {
          direction: 'outbound',
          actor: 'bot',
          category: 'reply_delivery',
          flow: 'napcat_send_dry_run',
          userId: params.userId,
          deliveryType: 'send_private_message',
          dispatchMode: 'dry_run',
          sideEffect: 'none',
          deliveryResult: 'dry_run',
          textPreview: previewText(params.text),
        },
        '私聊回复发送跳过（dry run）',
      )
      return { success: true, attempts: 0 }
    }

    return this.options.sendPrivateMessageFn(params.userId, [{ type: 'text', data: { text: params.text } }])
  }

  async sendGroupMessage(params: { groupId: number; text: string }): Promise<SendGroupReplyResult> {
    if (this.options.replyDryRun) {
      log.info(
        {
          direction: 'outbound',
          actor: 'bot',
          category: 'ambient_post',
          flow: 'napcat_send_dry_run',
          groupId: params.groupId,
          deliveryType: 'send_group_message',
          dispatchMode: 'dry_run',
          sideEffect: 'none',
          deliveryResult: 'dry_run',
          textPreview: previewText(params.text),
        },
        '主动群发跳过（dry run）',
      )
      return { success: true, attempts: 0 }
    }

    return this.options.sendGroupReplyFn(params.groupId, [{ type: 'text', data: { text: params.text } }])
  }
}

export function createMessageSender(options: MessageSenderOptions = {}): MessageSender {
  return new NapcatMessageSender({
    replyDryRun: options.replyDryRun ?? config.botReplyDryRun,
    sendGroupReplyFn: options.sendGroupReplyFn ?? sendGroupReply,
    sendPrivateMessageFn: options.sendPrivateMessageFn ?? sendPrivateMessage,
  })
}

export const messageSender: MessageSender = createMessageSender()
