import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import { config } from '../../config/index.js'

export interface SendGroupMessageDeps {
  sender: MessageSender
}

const MAX_TEXT_LENGTH = 500

export function createSendGroupMessageTool(deps: SendGroupMessageDeps): Tool<{
  text: string
  replyToMessageId?: number
  mentionUserId?: number
}> {
  return {
    name: 'send_group_message',
    description:
      '向 QQ 群真实发送一条消息。replyToMessageId 可选: 提供时回复某条消息(在该消息上挂引用); 不提供时主动插话。mentionUserId 可选: 在文本前加 @ 提及。assistant message 里写的内容只是你的内心想法,不会发出去——只有调这个工具才会真发。',
    schema: z.object({
      text: z.string().min(1).max(MAX_TEXT_LENGTH).describe('要发送的消息正文(<=500 字)'),
      replyToMessageId: z.number().int().optional().describe('回复某条群消息的 message_id (NapCat 数字 id)'),
      mentionUserId: z.number().int().optional().describe('要 @ 的群成员 QQ 号'),
    }),
    async execute(args) {
      const groupId = config.botTargetGroupIds[0] ?? 0

      if (args.replyToMessageId !== undefined) {
        const result = await deps.sender.replyToMessage({
          groupId,
          replyToMessageId: args.replyToMessageId,
          mentionUserId: args.mentionUserId,
          text: args.text,
        })
        return {
          content: JSON.stringify({
            ok: result.success,
            attempts: result.attempts,
            providerMessageId: result.providerMessageId ?? null,
            kind: 'reply',
          }),
        }
      }

      const result = await deps.sender.sendGroupMessage({ groupId, text: args.text })
      return {
        content: JSON.stringify({
          ok: result.success,
          attempts: result.attempts,
          providerMessageId: result.providerMessageId ?? null,
          kind: 'ambient',
        }),
      }
    },
  }
}
