import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import { imageHandleSchema, type ImageHandle } from '../../media/image-handle-schema.js'
import { resolveImageHandle, releaseHandle } from '../../media/image-handle.js'
import { promoteToMedia } from '../../media/promote-outbound.js'
import { buildOutboundSegments } from '../../messaging/segment-builder.js'
import type { SendTarget } from '../../messaging/napcat-sender.js'
import { prisma } from '../../database/client.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_SEND')

const MAX_TEXT_LENGTH = 500

export interface SendMessageDeps {
  sender: MessageSender
  /**
   * Group-ambient (没有 replyToMessageId 的群发送) 真发白名单.
   * 只有在此集合内的群才真发 ambient 消息; 不在的走 dry-run (假成功).
   * Reply、private 路径不受影响. 空集合 = 全部 dry-run.
   */
  groupAmbientSendIds: ReadonlySet<number>
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

const argsSchema = z
  .object({
    target: targetSchema.describe('显式发送目标. group 必传 groupId, private 必传 userId. 不要把私聊和群混淆.'),
    text: z.string().min(1).max(MAX_TEXT_LENGTH).describe('消息正文 (<= 500 字)').optional(),
    image: imageHandleSchema
      .describe('发图. {mediaId:N} 走存量, {ephemeralRef:"<hash>"} 走刚生成/抓取/截屏 (1h 内有效). 发出去会自动登记 mediaId 写进 tool result. text 和 image 至少一个非空.')
      .optional(),
    replyToMessageId: z
      .number()
      .int()
      .optional()
      .describe('回复某条已存在消息的 message_id. 直接抄消息标签里 `#NNNNN` 那个数 (例: `[群:阳光厨房 | 张三(QQ:100) #12345 [@bot]]` → 这里填 12345). 被 @ed 时通常回填; 主动开新话题时省略. 不要凭印象编, 编错就会回错条消息.'),
  })
  .refine((v) => v.text !== undefined || v.image !== undefined, {
    message: 'text 或 image 至少一个非空',
  })

type Args = z.infer<typeof argsSchema>

type SendKind = 'group-reply' | 'group-ambient' | 'private-reply' | 'private-ambient'

interface ImageResultPayload {
  mediaId: number | null
  ephemeralRef?: string
  dataHash?: string
  byteSize?: number
  contentType?: string
  lazyPersistError?: string
}

interface SendResultPayload {
  ok: boolean
  attempts: number
  providerMessageId: number | null
  kind: SendKind
  error?: string
  image?: ImageResultPayload
}

function classifySend(
  target: Args['target'],
  replyToMessageId: number | undefined,
): { kind: SendKind; sendTarget: SendTarget; mentionUserId?: number } {
  if (target.type === 'group') {
    const isReply = replyToMessageId !== undefined
    return {
      kind: isReply ? 'group-reply' : 'group-ambient',
      sendTarget: { type: 'group', groupId: target.groupId },
      mentionUserId: target.mentionUserId,
    }
  }
  const isReply = replyToMessageId !== undefined
  return {
    kind: isReply ? 'private-reply' : 'private-ambient',
    sendTarget: { type: 'private', userId: target.userId },
  }
}

function isDryRun(
  kind: SendKind,
  target: Args['target'],
  whitelist: ReadonlySet<number>,
): boolean {
  if (kind !== 'group-ambient') return false
  if (target.type !== 'group') return false
  return !whitelist.has(target.groupId)
}

export function createSendMessageTool(deps: SendMessageDeps): Tool<Args> {
  return {
    name: 'send_message',
    description: [
      '向 QQ 真实发送一条消息。target 必填, 决定这条消息发到哪个群 / 哪个私聊对方。',
      '群白名单已经在 ingress 层做过 —— 你能在 history 里看到的群消息, 那个群一定是可发的, 不需要自己再判断。私聊同样: 陌生 DM 在 ingress 层已被 sub_type=friend 挡掉, 你看到的 [私聊 | ...(QQ:N)] 一定可发回。',
      'target.type=group: 必传 groupId (来自消息标签 [群:名字 | 昵称(QQ:...)] 中暗含的 groupId, 可以用 db_read 查 messages 表 group_id 列). mentionUserId 可选, 在文本前加 @ 提及群内某人。',
      'target.type=private: 必传 userId (私聊对方 QQ).',
      'image 可选: 发图. {mediaId:N} 走存量, {ephemeralRef:"<hash>"} 走刚生成/抓取/截屏 (1h 内有效). 发出去会自动登记 mediaId 写进 tool result. text 和 image 至少一个非空.',
      'replyToMessageId 可选: 引用一条已存在消息. 数字必须等于该条消息标签里 `#` 后面的 message_id, 不要凭印象编. 被 @ed 时常回填以表示「我在回复你」, 主动插话或开新话题时省略.',
      'assistant message 里写的内容只是你的内心想法, 不会发出去 —— 只有调这个工具才会真发。',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = rawArgs as Args
      const { kind, sendTarget, mentionUserId } = classifySend(args.target, args.replyToMessageId)
      const dryRun = isDryRun(kind, args.target, deps.groupAmbientSendIds)

      if (dryRun) {
        if (kind === 'group-ambient' && mentionUserId !== undefined) {
          log.warn({ groupId: (args.target as { groupId: number }).groupId, mentionUserId }, 'send_message_group_ambient_with_mention_ignored')
        }
        const groupId = (args.target as { groupId: number }).groupId
        log.info({ groupId, kind }, 'send_message_group_ambient_dry_run')
        const payload: SendResultPayload = {
          ok: true,
          attempts: 1,
          providerMessageId: null,
          kind,
        }
        if (args.image) {
          const handle = args.image as ImageHandle
          payload.image = {
            mediaId: null,
            ...('ephemeralRef' in handle ? { ephemeralRef: handle.ephemeralRef } : {}),
            ...('mediaId' in handle ? { mediaId: handle.mediaId } : {}),
          }
        }
        return { content: JSON.stringify(payload) }
      }

      if (kind === 'group-ambient' && mentionUserId !== undefined) {
        log.warn({ groupId: (args.target as { groupId: number }).groupId, mentionUserId }, 'send_message_group_ambient_with_mention_ignored')
      }

      // Text-only path: use legacy sender methods for backward compat
      if (!args.image) {
        return await sendTextOnly(deps, args, kind, sendTarget, mentionUserId)
      }

      // Image path: resolve handle → build segments → sendSegments → lazy persist
      return await sendWithImage(deps, args, kind, sendTarget, mentionUserId, dryRun)
    },
  }
}

async function sendTextOnly(
  deps: SendMessageDeps,
  args: Args,
  kind: SendKind,
  sendTarget: SendTarget,
  mentionUserId: number | undefined,
): Promise<{ content: string }> {
  const text = args.text!

  if (sendTarget.type === 'group') {
    if (args.replyToMessageId !== undefined) {
      const result = await deps.sender.replyToMessage({
        groupId: sendTarget.groupId,
        replyToMessageId: args.replyToMessageId,
        mentionUserId,
        text,
      })
      return { content: JSON.stringify(buildPayload(result, kind)) }
    }
    const result = await deps.sender.sendGroupMessage({ groupId: sendTarget.groupId, text })
    return { content: JSON.stringify(buildPayload(result, kind)) }
  }

  const result = await deps.sender.sendPrivateMessage({
    userId: sendTarget.userId,
    text,
    replyToMessageId: args.replyToMessageId,
  })
  return { content: JSON.stringify(buildPayload(result, kind)) }
}

async function sendWithImage(
  deps: SendMessageDeps,
  args: Args,
  kind: SendKind,
  sendTarget: SendTarget,
  mentionUserId: number | undefined,
  dryRun: boolean,
): Promise<{ content: string }> {
  const handle = args.image as ImageHandle
  let resolved: Awaited<ReturnType<typeof resolveImageHandle>>
  try {
    resolved = await resolveImageHandle(handle, { acquire: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ handle, error: message }, 'send_message_image_resolve_failed')
    return {
      content: JSON.stringify({
        ok: false,
        attempts: 0,
        providerMessageId: null,
        kind,
        error: `image resolve failed: ${message}`,
      }),
    }
  }

  try {
    const segments = buildOutboundSegments({
      replyToMessageId: args.replyToMessageId,
      mentionUserId,
      text: args.text,
      imageBytes: resolved.bytes,
    })

    const result = await deps.sender.sendSegments({ target: sendTarget, segments })

    if (!result.success) {
      const payload: SendResultPayload = {
        ok: false,
        attempts: result.attempts,
        providerMessageId: null,
        kind,
        error: `${kind} send failed (see SEND log)`,
      }
      return { content: JSON.stringify(payload) }
    }

    // Lazy persist: ephemeralRef + send succeeded + not dry-run
    const imageResult: ImageResultPayload = {
      mediaId: null,
      dataHash: resolved.dataHash,
      byteSize: resolved.byteSize,
      contentType: resolved.contentType,
    }

    if ('mediaId' in handle) {
      imageResult.mediaId = handle.mediaId
    } else if ('ephemeralRef' in handle) {
      imageResult.ephemeralRef = handle.ephemeralRef
      if (!dryRun) {
        try {
          imageResult.mediaId = await promoteToMedia({
            bytes: resolved.bytes,
            dataHash: resolved.dataHash,
            contentType: resolved.contentType,
            description: resolved.description,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error({ ephemeralRef: handle.ephemeralRef, error: message }, 'send_message_lazy_persist_failed')
          imageResult.lazyPersistError = message
        }
      }
    }

    const payload: SendResultPayload = {
      ok: true,
      attempts: result.attempts,
      providerMessageId: result.providerMessageId ?? null,
      kind,
      image: imageResult,
    }

    if (imageResult.mediaId != null) {
      prisma.stickerPool
        .updateMany({
          where: { mediaId: imageResult.mediaId },
          data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
        })
        .catch(() => {})
    }

    return { content: JSON.stringify(payload) }
  } finally {
    releaseHandle(handle)
  }
}

function buildPayload(
  result: { success: boolean; attempts: number; providerMessageId?: number },
  kind: SendKind,
): SendResultPayload {
  const payload: SendResultPayload = {
    ok: result.success,
    attempts: result.attempts,
    providerMessageId: result.providerMessageId ?? null,
    kind,
  }
  if (!result.success) payload.error = `${kind} send failed (see SEND log)`
  return payload
}
