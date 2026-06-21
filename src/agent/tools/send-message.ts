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
const imageRefSchema = z
  .string()
  .regex(/^(?:media:\d+|ephemeral:[a-f0-9]{64})$/)

const argsSchema = z
  .object({
    target: targetSchema.describe('显式发送目标. group 必传 groupId, private 必传 userId. 不要把私聊和群混淆.'),
    mode: z.enum(['ambient', 'reply']).optional().describe('ambient=顺聊/主动说一句, 不引用消息; reply=明确回复某条 message_id.'),
    text: z.string().min(1).max(MAX_TEXT_LENGTH).nullable().optional().describe('消息正文 (<= 500 字). 不发文字时填 null.'),
    imageRef: imageRefSchema
      .nullable()
      .optional()
      .describe('发图句柄. 无图填 null. 存量图用 media:<id>, 刚生成/抓取/截屏用 ephemeral:<64-hex>. 不要猜.'),
    replyToMessageId: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('mode=reply 时填消息标签里 # 后面的 message_id; mode=ambient 必须填 null. 不要凭印象编.'),
  })
  .refine((v) => v.text != null || v.imageRef != null, {
    message: 'text 或 imageRef 至少一个非空',
  })
  .refine((v) => v.mode !== 'reply' || v.replyToMessageId != null, {
    message: 'mode=reply 时必须提供 replyToMessageId',
  })

interface Args {
  target: z.infer<typeof targetSchema>
  mode?: 'ambient' | 'reply' | null
  text?: string | null
  image?: ImageHandle
  imageRef?: string | null
  replyToMessageId?: number | null
}

interface NormalizedArgs {
  target: z.infer<typeof targetSchema>
  mode: 'ambient' | 'reply'
  text?: string
  image?: ImageHandle
  replyToMessageId?: number
}

type SendKind = 'group-reply' | 'group-ambient' | 'private-reply' | 'private-ambient'

interface ImageResultPayload {
  mediaId: number | null
  ephemeralRef?: string
  dataHash?: string
  byteSize?: number
  contentType?: string
  lazyPersistError?: string
  resolveError?: string
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
      'target.type=group: 必传 groupId (来自消息标签 [群:名字 | 昵称(QQ:...)] 中暗含的 groupId, 可以用 db action=query 查 messages 表 group_id 列). mentionUserId 可选, 在文本前加 @ 提及群内某人。',
      'target.type=private: 必传 userId (私聊对方 QQ).',
      'mode 必填: 顺聊/上下文明确时用 ambient, replyToMessageId 填 null; 只有多人多话题混杂、需要精确指向某条消息时才用 reply.',
      'imageRef 必填但通常是 null. 只在你明确拿到了可用句柄时才填: media:<id> 或 ephemeral:<64-hex>; 不确定就填 null, 只发 text. text 和 imageRef 至少一个非 null.',
      'replyToMessageId 必填: mode=ambient 时填 null; mode=reply 时数字必须等于消息标签里 `#` 后面的 message_id, 不要凭印象编.',
      'text 是会发给 QQ 的用户可见正文; 不要把思考、自我检查、tool 参数调试或元评论写进 text。只有调这个工具才会真发。',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = normalizeSendArgs(rawArgs as Args)
      const text = args.text ? normalizeSendText(args.text) : undefined
      const normalizedArgs = { ...args, ...(text ? { text } : { text: undefined }) }
      if (!normalizedArgs.text && !normalizedArgs.image) {
        return {
          content: JSON.stringify({
            ok: false,
            attempts: 0,
            providerMessageId: null,
            kind: classifySend(normalizedArgs.target, normalizedArgs.replyToMessageId).kind,
            error: 'send_message text became empty after normalization',
          }),
        }
      }
      const { kind, sendTarget, mentionUserId } = classifySend(
        normalizedArgs.target,
        normalizedArgs.replyToMessageId,
      )
      const dryRun = isDryRun(kind, normalizedArgs.target, deps.groupAmbientSendIds)

      if (dryRun) {
        const groupId = (normalizedArgs.target as { groupId: number }).groupId
        log.info({ groupId, kind }, 'send_message_group_ambient_dry_run')
        const payload: SendResultPayload = {
          ok: true,
          attempts: 1,
          providerMessageId: null,
          kind,
        }
        if (normalizedArgs.image) {
          const handle = normalizedArgs.image as ImageHandle
          payload.image = {
            mediaId: null,
            ...('ephemeralRef' in handle ? { ephemeralRef: handle.ephemeralRef } : {}),
            ...('mediaId' in handle ? { mediaId: handle.mediaId } : {}),
          }
        }
        return { content: JSON.stringify(payload) }
      }

      // Text-only path: use legacy sender methods for backward compat
      if (!normalizedArgs.image) {
        return await sendTextOnly(deps, normalizedArgs, kind, sendTarget, mentionUserId)
      }

      // Image path: resolve handle → build segments → sendSegments → lazy persist
      return await sendWithImage(deps, normalizedArgs, kind, sendTarget, mentionUserId, dryRun)
    },
  }
}

export function normalizeSendText(text: string): string {
  return text
    .replace(/[\u200b-\u200f\ufeff]/gu, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function normalizeSendArgs(args: Args): NormalizedArgs {
  const mode = args.mode ?? (args.replyToMessageId != null ? 'reply' : 'ambient')
  const image = args.image ?? imageRefToHandle(args.imageRef ?? null)
  return {
    target: args.target,
    mode,
    text: args.text ?? undefined,
    image,
    replyToMessageId: mode === 'reply' ? args.replyToMessageId ?? undefined : undefined,
  }
}

function imageRefToHandle(ref: string | null): ImageHandle | undefined {
  if (!ref) return undefined
  if (ref.startsWith('media:')) {
    const mediaId = Number(ref.slice('media:'.length))
    return Number.isSafeInteger(mediaId) && mediaId > 0 ? { mediaId } : undefined
  }
  if (ref.startsWith('ephemeral:')) {
    return { ephemeralRef: ref.slice('ephemeral:'.length) }
  }
  return undefined
}

async function sendTextOnly(
  deps: SendMessageDeps,
  args: NormalizedArgs,
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
    const result = await deps.sender.sendGroupMessage({ groupId: sendTarget.groupId, text, mentionUserId })
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
  args: NormalizedArgs,
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
    if (args.text) {
      const textOnly = await sendTextOnly(deps, args, kind, sendTarget, mentionUserId)
      const payload = JSON.parse(textOnly.content) as SendResultPayload
      payload.image = {
        mediaId: 'mediaId' in handle ? handle.mediaId : null,
        ...('ephemeralRef' in handle ? { ephemeralRef: handle.ephemeralRef } : {}),
        resolveError: message,
      }
      return { content: JSON.stringify(payload) }
    }
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
