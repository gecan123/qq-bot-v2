import { sendGroupReply, type SendGroupReplyResult } from '../responder/reply-executor.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { buildReplySegments } from './segment-builder.js'

const log = createLogger('MESSAGE_SENDER')

export interface MessageSender {
  isReplyDryRunEnabled?(): boolean

  replyToMessage(params: {
    groupId: number
    replyToMessageId: number
    mentionUserId?: number
    text: string
  }): Promise<SendGroupReplyResult>

  /** 发送独立消息（不引用、不 @），用于主动回复 */
  sendMessage(params: {
    groupId: number
    text: string
  }): Promise<SendGroupReplyResult>
}

export interface MessageSenderOptions {
  replyDryRun?: boolean
  proactiveDryRun?: boolean
  sendGroupReplyFn?: typeof sendGroupReply
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
          groupId: params.groupId,
          replyToMessageId: params.replyToMessageId,
          mentionUserId: params.mentionUserId,
          preview: params.text.slice(0, 60),
        },
        'replyToMessage dry run: skipped outbound send',
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

  async sendMessage(params: { groupId: number; text: string }): Promise<SendGroupReplyResult> {
    if (this.options.proactiveDryRun) {
      log.info(
        {
          groupId: params.groupId,
          preview: params.text.slice(0, 60),
        },
        'sendMessage dry run: skipped outbound send',
      )
      return { success: true, attempts: 0 }
    }

    return this.options.sendGroupReplyFn(params.groupId, [{ type: 'text', data: { text: params.text } }])
  }
}

export function createMessageSender(options: MessageSenderOptions = {}): MessageSender {
  return new NapcatMessageSender({
    replyDryRun: options.replyDryRun ?? config.botReplyDryRun,
    proactiveDryRun: options.proactiveDryRun ?? config.botProactiveDryRun,
    sendGroupReplyFn: options.sendGroupReplyFn ?? sendGroupReply,
  })
}

export const messageSender: MessageSender = createMessageSender()
