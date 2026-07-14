import { z } from 'zod'
import type { Tool, ToolExecutionResult } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import type { SendMode, SendTarget, SendTargetPolicy } from '../send-target-policy.js'
import type { ImageHandle } from '../../media/image-handle-schema.js'
import { resolveImageHandle, releaseHandle } from '../../media/image-handle.js'
import { promoteToMedia } from '../../media/promote-outbound.js'
import { buildOutboundSegments, type MusicShare } from '../../messaging/segment-builder.js'
import type { SendTarget as NapcatSendTarget } from '../../messaging/napcat-sender.js'
import { prisma } from '../../database/client.js'
import { createLogger } from '../../logger.js'
import {
  groupMuteInspector as defaultGroupMuteInspector,
  type GroupMuteInspector,
} from '../../messaging/group-mute-inspector.js'

const log = createLogger('TOOL_SEND')
const MAX_TEXT_LENGTH = 500

export interface SendMessageDeps {
  sender: MessageSender
  targetPolicy: SendTargetPolicy
  groupMuteInspector?: GroupMuteInspector
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
const imageRefSchema = z.string().regex(/^(?:media:\d+|ephemeral:[a-f0-9]{64})$/)
const httpsUrlSchema = z.string().url().refine((value) => new URL(value).protocol === 'https:', {
  message: '必须使用 https URL',
})
const musicSchema = z.object({
  platform: z.enum(['qq', '163', 'kugou', 'kuwo', 'migu', 'custom'])
    .describe('音乐平台. custom 时改用自定义卡片字段.'),
  id: z.string().min(1).max(100).optional()
    .describe('platform 非 custom 时必填的平台歌曲 ID.'),
  url: httpsUrlSchema.optional().describe('platform=custom 时必填的音乐播放或落地页 HTTPS URL.'),
  image: httpsUrlSchema.optional().describe('platform=custom 时必填的音乐封面 HTTPS URL.'),
  title: z.string().min(1).max(100).optional().describe('platform=custom 时必填的标题.'),
  singer: z.string().min(1).max(100).optional(),
  content: z.string().min(1).max(200).optional(),
}).superRefine((music, ctx) => {
  if (music.platform === 'custom') {
    for (const field of ['url', 'image', 'title'] as const) {
      if (!music[field]) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required when platform=custom` })
      }
    }
    if (music.id) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: 'id is not allowed when platform=custom' })
    }
    return
  }
  if (!music.id) {
    ctx.addIssue({ code: 'custom', path: ['id'], message: 'id is required for platform music' })
  }
  for (const field of ['url', 'image', 'title', 'singer', 'content'] as const) {
    if (music[field]) {
      ctx.addIssue({ code: 'custom', path: [field], message: `${field} is only allowed when platform=custom` })
    }
  }
})
const contentFields = {
  target: targetSchema.describe('显式发送目标. group 必传 groupId, private 必传 userId.'),
  text: z.string().min(1).max(MAX_TEXT_LENGTH).nullable().optional(),
  imageRef: imageRefSchema.nullable().optional(),
  music: musicSchema.nullable().optional(),
}

const argsSchema = z.discriminatedUnion('mode', [
  z.object({
    ...contentFields,
    mode: z.literal('ambient'),
    replyToMessageId: z.null(),
  }),
  z.object({
    ...contentFields,
    mode: z.literal('reply'),
    replyToMessageId: z.number().int(),
  }),
]).refine((value) => value.text != null || value.imageRef != null || value.music != null, {
  message: 'text、imageRef 或 music 至少一个非空',
})

interface Args {
  target: SendTarget
  mode: SendMode
  text?: string | null
  /** 仅供内部测试/调用；LLM schema 只暴露 imageRef。 */
  image?: ImageHandle
  imageRef?: string | null
  music?: MusicShare | null
  replyToMessageId: number | null
}

interface ImageResultPayload {
  mediaId: number | null
  ephemeralRef?: string
  dataHash?: string
  byteSize?: number
  contentType?: string
  lazyPersistError?: string
  resolveError?: string
}

interface SendReceipt {
  ok: boolean
  status: 'sent' | 'rejected' | 'failed'
  target: SendTarget
  mode: SendMode
  attempts: number
  providerMessageId: number | null
  reason?: 'send_failed' | 'group_muted'
  mutedUntil?: string
  error?: string
  image?: ImageResultPayload
}

type SendToolResult = ToolExecutionResult & { content: string }

export function createSendMessageTool(deps: SendMessageDeps): Tool<Args> {
  return {
    name: 'send_message',
    description: [
      '向 QQ 真实发送一条消息。target 必填并明确区分 group/private。',
      '文本、图片和图文消息都统一使用 send_message；不存在 send_image 工具。发送图片时把已有句柄传给 imageRef。',
      '音乐卡片也走本工具: music.platform 支持 qq/163/kugou/kuwo/migu + id, 或 custom + https url/image/title.',
      'mode=ambient 时 replyToMessageId 必须为 null；mode=reply 时必须提供消息标签中 # 后面的 message_id。',
      '群 ambient 只能发到主动发送白名单；不在主动发送白名单的监听群只允许 reply 明确 @ 机器人的消息。私聊只能发给当前 QQ 好友。未授权会明确拒绝，不会模拟成功。',
      'group target 可选 mentionUserId；private target 不支持 mentionUserId。',
      'imageRef 使用 media:<id> 或 ephemeral:<64-hex>；text、imageRef 和 music 至少一个非 null。',
      'text 是 QQ 用户可见正文，最多 500 字。只有调用本工具才会真实发送。',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = normalizeArgs(rawArgs as Args)
      const authorization = await deps.targetPolicy.authorize({
        target: args.target,
        mode: args.mode,
        replyToMessageId: args.replyToMessageId,
      })
      if (!authorization.allowed) {
        return { content: JSON.stringify(buildReceipt(args, 'rejected', 0, null, authorization.error)) }
      }

      if (!args.text && !args.image && !args.music) {
        return {
          content: JSON.stringify(buildReceipt(
            args,
            'rejected',
            0,
            null,
            'send_message text became empty after normalization',
          )),
        }
      }

      if (!args.image) return sendResolved(deps, args)
      return sendWithImage(deps, { ...args, image: args.image })
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

function normalizeArgs(args: Args): Args & { text?: string; image?: ImageHandle } {
  const text = args.text ? normalizeSendText(args.text) : undefined
  return {
    ...args,
    text: text || undefined,
    image: args.image ?? imageRefToHandle(args.imageRef ?? null),
  }
}

function imageRefToHandle(ref: string | null): ImageHandle | undefined {
  if (!ref) return undefined
  if (ref.startsWith('media:')) {
    const mediaId = Number(ref.slice('media:'.length))
    return Number.isSafeInteger(mediaId) && mediaId > 0 ? { mediaId } : undefined
  }
  if (ref.startsWith('ephemeral:')) return { ephemeralRef: ref.slice('ephemeral:'.length) }
  return undefined
}

async function sendResolved(
  deps: SendMessageDeps,
  args: Args & { text?: string; image?: ImageHandle },
  imageBytes?: Buffer,
): Promise<SendToolResult> {
  const segments = buildOutboundSegments({
    replyToMessageId: args.mode === 'reply' ? args.replyToMessageId ?? undefined : undefined,
    mentionUserId: args.target.type === 'group' ? args.target.mentionUserId : undefined,
    text: args.text,
    imageBytes,
    music: args.music ?? undefined,
  })
  const result = await deps.sender.sendSegments({
    target: toNapcatTarget(args.target),
    segments,
  })
  if (!result.success) {
    const diagnosis = await diagnoseSendFailure(deps, args.target)
    return {
      content: JSON.stringify({
        ...buildReceipt(
          args,
          'failed',
          result.attempts,
          null,
          'send failed (see SEND log)',
        ),
        ...diagnosis,
      }),
    }
  }
  return {
    content: JSON.stringify(buildReceipt(
      args,
      'sent',
      result.attempts,
      result.providerMessageId ?? null,
    )),
    effects: [{ type: 'message_sent', target: toNapcatTarget(args.target) }],
  }
}

async function diagnoseSendFailure(
  deps: SendMessageDeps,
  target: SendTarget,
): Promise<Pick<SendReceipt, 'reason' | 'mutedUntil'>> {
  if (target.type !== 'group') return { reason: 'send_failed' }
  try {
    const inspection = await (deps.groupMuteInspector ?? defaultGroupMuteInspector).inspect(target.groupId)
    if (!inspection.muted) return { reason: 'send_failed' }
    return {
      reason: 'group_muted',
      ...(inspection.mutedUntil ? { mutedUntil: inspection.mutedUntil } : {}),
    }
  } catch (error) {
    log.warn({ groupId: target.groupId, error }, 'send_message_group_mute_inspection_failed')
    return { reason: 'send_failed' }
  }
}

async function sendWithImage(
  deps: SendMessageDeps,
  args: Args & { text?: string; image: ImageHandle },
): Promise<SendToolResult> {
  const handle = args.image
  let resolved: Awaited<ReturnType<typeof resolveImageHandle>>
  try {
    resolved = await resolveImageHandle(handle, { acquire: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn({ handle, error: message }, 'send_message_image_resolve_failed')
    if (!args.text) {
      return {
        content: JSON.stringify(buildReceipt(
          args,
          'failed',
          0,
          null,
          `image resolve failed: ${message}`,
        )),
      }
    }
    const fallbackResult = await sendResolved(deps, args)
    const fallback = JSON.parse(fallbackResult.content) as SendReceipt
    fallback.image = {
      mediaId: 'mediaId' in handle ? handle.mediaId : null,
      ...('ephemeralRef' in handle ? { ephemeralRef: handle.ephemeralRef } : {}),
      resolveError: message,
    }
    return { content: JSON.stringify(fallback), effects: fallbackResult.effects }
  }

  try {
    const sendResult = await sendResolved(deps, args, resolved.bytes)
    const sent = JSON.parse(sendResult.content) as SendReceipt
    if (sent.status !== 'sent') return { content: JSON.stringify(sent) }

    const image: ImageResultPayload = {
      mediaId: null,
      dataHash: resolved.dataHash,
      byteSize: resolved.byteSize,
      contentType: resolved.contentType,
    }
    if ('mediaId' in handle) {
      image.mediaId = handle.mediaId
    } else {
      image.ephemeralRef = handle.ephemeralRef
      try {
        image.mediaId = await promoteToMedia({
          bytes: resolved.bytes,
          dataHash: resolved.dataHash,
          contentType: resolved.contentType,
          description: resolved.description,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error({ ephemeralRef: handle.ephemeralRef, error: message }, 'send_message_lazy_persist_failed')
        image.lazyPersistError = message
      }
    }
    sent.image = image

    if (image.mediaId != null) {
      prisma.stickerPool.updateMany({
        where: { mediaId: image.mediaId },
        data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
      }).catch(() => {})
    }
    return { content: JSON.stringify(sent), effects: sendResult.effects }
  } finally {
    releaseHandle(handle)
  }
}

function toNapcatTarget(target: SendTarget): NapcatSendTarget {
  return target.type === 'group'
    ? { type: 'group', groupId: target.groupId }
    : { type: 'private', userId: target.userId }
}

function buildReceipt(
  args: Pick<Args, 'target' | 'mode'>,
  status: SendReceipt['status'],
  attempts: number,
  providerMessageId: number | null,
  error?: string,
): SendReceipt {
  return {
    ok: status === 'sent',
    status,
    target: args.target,
    mode: args.mode,
    attempts,
    providerMessageId,
    ...(error ? { error } : {}),
  }
}
