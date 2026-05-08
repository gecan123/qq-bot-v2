import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_SEND')

const MAX_TEXT_LENGTH = 500

export interface SendMessageDeps {
  sender: MessageSender
  /**
   * Group-ambient (没有 replyToMessageId 的群发送) dry-run 开关.
   * true → 不走 NapCat, 对 LLM 返回假成功; false → 正常真发.
   * Reply、private 和 group ambient 之外的路径不受影响.
   */
  groupAmbientDryRun: boolean
}

const groupTargetSchema = z.object({
  type: z.literal('group'),
  groupId: z.number().int(),
  mentionUserId: z.number().int().optional(),
})

const privateTargetSchema = z.object({
  type: z.literal('private'),
  userId: z.number().int(),
})

const targetSchema = z.union([groupTargetSchema, privateTargetSchema])

const argsSchema = z.object({
  target: targetSchema.describe('显式发送目标. group 必传 groupId, private 必传 userId. 不要把私聊和群混淆.'),
  text: z.string().min(1).max(MAX_TEXT_LENGTH).describe('消息正文 (<= 500 字)'),
  replyToMessageId: z
    .number()
    .int()
    .optional()
    .describe('回复某条已存在消息的 message_id. 被 @ed 时通常回填; 主动开新话题时省略.'),
})

type Args = z.infer<typeof argsSchema>

type SendKind = 'group-reply' | 'group-ambient' | 'private-reply' | 'private-ambient'

interface SendResultPayload {
  ok: boolean
  attempts: number
  providerMessageId: number | null
  kind: SendKind
  error?: string
}

export function createSendMessageTool(deps: SendMessageDeps): Tool<Args> {
  return {
    name: 'send_message',
    description: [
      '向 QQ 真实发送一条消息。target 必填, 决定这条消息发到哪个群 / 哪个私聊对方。',
      '群白名单已经在 ingress 层做过 —— 你能在 history 里看到的群消息, 那个群一定是可发的, 不需要自己再判断。私聊同样: 陌生 DM 在 ingress 层已被 sub_type=friend 挡掉, 你看到的 [私聊 | ...(QQ:N)] 一定可发回。',
      'target.type=group: 必传 groupId (来自消息标签 [群:名字 | 昵称(QQ:...)] 中暗含的 groupId, 可以用 db_read 查 messages 表 group_id 列). mentionUserId 可选, 在文本前加 @ 提及群内某人。',
      'target.type=private: 必传 userId (私聊对方 QQ).',
      'replyToMessageId 可选: 引用一条已存在消息. 被 @ed 时常回填以表示「我在回复你」, 主动插话或开新话题时省略.',
      'assistant message 里写的内容只是你的内心想法, 不会发出去 —— 只有调这个工具才会真发。',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = rawArgs as Args

      if (args.target.type === 'group') {
        const { groupId, mentionUserId } = args.target
        const isReply = args.replyToMessageId !== undefined
        const kind: SendKind = isReply ? 'group-reply' : 'group-ambient'

        if (isReply) {
          const result = await deps.sender.replyToMessage({
            groupId,
            replyToMessageId: args.replyToMessageId!,
            mentionUserId,
            text: args.text,
          })
          const payload: SendResultPayload = {
            ok: result.success,
            attempts: result.attempts,
            providerMessageId: result.providerMessageId ?? null,
            kind,
          }
          if (!result.success) payload.error = 'group reply send failed (see SEND log)'
          return { content: JSON.stringify(payload) }
        }

        // ambient (no reply). mentionUserId on ambient is handled by callers via plain @ in text;
        // 当前不在 ambient 路径里支持 mentionUserId, 因为 message-sender.sendGroupMessage 没暴露.
        // 想 @ 别人时调用方应当给 replyToMessageId, 让它走 reply path.
        if (mentionUserId !== undefined) {
          log.warn({ groupId, mentionUserId }, 'send_message_group_ambient_with_mention_ignored')
        }

        if (deps.groupAmbientDryRun) {
          // dry-run: 不走 NapCat, 对 LLM 返回假成功. 群友感知不到, 但 LLM 以为说出去了.
          // 红线 3「history 里出现的发言一定真发出去过」在此处有意打破, 观察期专用.
          log.info({ groupId, kind }, 'send_message_group_ambient_dry_run')
          const payload: SendResultPayload = {
            ok: true,
            attempts: 1,
            providerMessageId: null,
            kind,
          }
          return { content: JSON.stringify(payload) }
        } else {
          const result = await deps.sender.sendGroupMessage({ groupId, text: args.text })
          const payload: SendResultPayload = {
            ok: result.success,
            attempts: result.attempts,
            providerMessageId: result.providerMessageId ?? null,
            kind,
          }
          if (!result.success) payload.error = 'group ambient send failed (see SEND log)'
          return { content: JSON.stringify(payload) }
        }
      }

      // private
      const { userId } = args.target
      const isReply = args.replyToMessageId !== undefined
      const kind: SendKind = isReply ? 'private-reply' : 'private-ambient'

      const result = await deps.sender.sendPrivateMessage({
        userId,
        text: args.text,
        replyToMessageId: args.replyToMessageId,
      })
      const payload: SendResultPayload = {
        ok: result.success,
        attempts: result.attempts,
        providerMessageId: result.providerMessageId ?? null,
        kind,
      }
      if (!result.success) payload.error = 'private send failed (see SEND log)'
      return { content: JSON.stringify(payload) }
    },
  }
}
