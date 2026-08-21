import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ConversationRef } from '../../chat/conversation.js'
import type { MessageDelivery } from '../../messaging/message-delivery.js'
import type { MusicShare } from '../../messaging/segment-builder.js'
import type { ImageHandle } from '../../media/image-handle-schema.js'
import { resolveImageHandle, releaseHandle } from '../../media/image-handle.js'
import { promoteToMedia } from '../../media/promote-outbound.js'
import type { ConversationSendPolicy, SendMode } from '../conversation-send-policy.js'
import type { Tool, ToolExecutionResult } from '../tool.js'
import type { ConversationController } from './conversation.js'
import {
  groupMuteInspector as defaultGroupMuteInspector,
  type GroupMuteInspector,
} from '../../messaging/group-mute-inspector.js'

const MAX_TEXT_LENGTH = 500
const imageRefSchema = z.string().regex(/^(?:media:\d+|ephemeral:[a-f0-9]{64})$/)
const httpsUrlSchema = z.string().url().refine((value) => new URL(value).protocol === 'https:', {
  message: '必须使用 https URL',
})
const musicSchema = z.object({
  platform: z.enum(['qq', '163', 'kugou', 'kuwo', 'migu', 'custom']),
  id: z.string().min(1).max(100).optional(),
  url: httpsUrlSchema.optional(),
  image: httpsUrlSchema.optional(),
  title: z.string().min(1).max(100).optional(),
  singer: z.string().min(1).max(100).optional(),
  content: z.string().min(1).max(200).optional(),
}).superRefine((music, ctx) => {
  if (music.platform === 'custom') {
    for (const field of ['url', 'image', 'title'] as const) {
      if (!music[field]) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required when platform=custom` })
    }
    if (music.id) ctx.addIssue({ code: 'custom', path: ['id'], message: 'id is not allowed when platform=custom' })
    return
  }
  if (!music.id) ctx.addIssue({ code: 'custom', path: ['id'], message: 'id is required for platform music' })
  for (const field of ['url', 'image', 'title', 'singer', 'content'] as const) {
    if (music[field]) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is only allowed when platform=custom` })
  }
})
const workBindingSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }),
  z.object({ state: z.literal('continue') }),
  z.object({ state: z.literal('goal_progress'), goalId: z.string().uuid() }),
])
const argsSchema = z.object({
  message: z.string().min(1).max(MAX_TEXT_LENGTH).nullable().optional(),
  imageRef: imageRefSchema.nullable().optional(),
  music: musicSchema.nullable().optional(),
  reply_to: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  mention_external_id: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  work: workBindingSchema,
}).refine((value) => value.message != null || value.imageRef != null || value.music != null, {
  message: 'message、imageRef 或 music 至少一个非空',
})

interface Args {
  message?: string | null
  image?: ImageHandle
  imageRef?: string | null
  music?: MusicShare | null
  reply_to?: string | number
  mention_external_id?: string | number
  work:
    | { state: 'none' }
    | { state: 'continue' }
    | { state: 'goal_progress'; goalId: string }
}

export interface SendMessageDeps {
  delivery: MessageDelivery
  targetPolicy: ConversationSendPolicy
  conversations: ConversationController
  resolveImage?: typeof resolveImageHandle
  releaseImage?: typeof releaseHandle
  promoteImage?: typeof promoteToMedia
  actionId?: () => string
  groupMuteInspector?: GroupMuteInspector
}

export function createSendMessageTool(deps: SendMessageDeps): Tool<Args> {
  return {
    name: 'send_message',
    description: [
      '向当前显式打开的 QQ / 飞书会话真实发送消息；发送前必须先用 conversation open。',
      '支持文本、图片、引用回复和群内 @；reply_to 与 mention_external_id 使用平台消息或用户 ID。',
      'music 是 QQ 专属扩展；飞书目标会明确失败，不会假装成功。',
      '每次调用生成稳定 actionId，结果只会是 sent、failed 或 delivery_unknown。',
      'work 必填：none 表示没有后续工作，continue 表示当前会话立即继续，goal_progress 绑定 active Goal。',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const current = await deps.conversations.resolveCurrent()
      if (!current.ok) return conversationError(current.code)
      const args = rawArgs as Args
      const text = args.message ? normalizeSendText(args.message) : undefined
      const image = args.image ?? imageRefToHandle(args.imageRef ?? null)
      const replyToExternalId = args.reply_to == null ? undefined : String(args.reply_to)
      const mentionExternalId = args.mention_external_id == null
        ? undefined
        : String(args.mention_external_id)
      const mode: SendMode = replyToExternalId == null ? 'ambient' : 'reply'
      const authorization = await deps.targetPolicy.authorize({
        target: current.target,
        mode,
        ...(replyToExternalId ? { replyToExternalId } : {}),
      })
      if (!authorization.allowed) {
        return failedResult({
          status: 'failed', code: 'send_rejected', error: authorization.error,
          target: current.target, mode,
        })
      }
      if (!text && !image && !args.music) {
        return failedResult({
          status: 'failed', code: 'empty_message', error: 'message is empty', target: current.target, mode,
        })
      }
      if (args.music && current.target.platform !== 'qq') {
        return failedResult({
          status: 'failed', code: 'platform_payload_unsupported',
          error: 'music is only supported for QQ targets', target: current.target, mode,
        })
      }

      const actionId = (deps.actionId ?? randomUUID)()
      if (!image) {
        return deliver(deps, {
          actionId, target: current.target, mode, text, replyToExternalId, mentionExternalId,
          music: args.music ?? undefined, workState: args.work.state,
        })
      }

      let resolved: Awaited<ReturnType<typeof resolveImageHandle>>
      try {
        resolved = await (deps.resolveImage ?? resolveImageHandle)(image, { acquire: true })
      } catch (error) {
        return failedResult({
          actionId, status: 'failed', code: 'image_resolve_failed',
          error: error instanceof Error ? error.message : String(error),
          target: current.target, mode,
        })
      }
      try {
        const result = await deliver(deps, {
          actionId, target: current.target, mode, text, imageBytes: resolved.bytes,
          replyToExternalId, mentionExternalId, music: args.music ?? undefined,
          workState: args.work.state,
        })
        if (result.outcome?.ok && 'ephemeralRef' in image) {
          await (deps.promoteImage ?? promoteToMedia)({
            bytes: resolved.bytes,
            dataHash: resolved.dataHash,
            contentType: resolved.contentType,
            description: resolved.description,
          }).catch(() => undefined)
        }
        return result
      } finally {
        ;(deps.releaseImage ?? releaseHandle)(image)
      }
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

async function deliver(
  deps: SendMessageDeps,
  input: {
    actionId: string
    target: ConversationRef
    mode: SendMode
    text?: string
    imageBytes?: Buffer
    replyToExternalId?: string
    mentionExternalId?: string
    music?: MusicShare
    workState: Args['work']['state']
  },
): Promise<ToolExecutionResult> {
  let result = await deps.delivery.send({
    actionId: input.actionId,
    target: input.target,
    ...(input.text ? { text: input.text } : {}),
    ...(input.imageBytes ? { imageBytes: input.imageBytes } : {}),
    ...(input.replyToExternalId ? { replyToExternalId: input.replyToExternalId } : {}),
    ...(input.mentionExternalId ? { mentionExternalId: input.mentionExternalId } : {}),
    ...(input.music ? { platformPayload: input.music } : {}),
  })
  if (
    result.status === 'failed'
    && input.target.platform === 'qq'
    && input.target.kind === 'group'
  ) {
    const groupId = Number(input.target.externalId)
    if (Number.isSafeInteger(groupId) && groupId > 0) {
      try {
        const inspection = await (deps.groupMuteInspector ?? defaultGroupMuteInspector).inspect(groupId)
        if (inspection.muted) {
          result = {
            ...result,
            code: 'group_muted',
            error: inspection.mutedUntil
              ? `QQ group is muted until ${inspection.mutedUntil}`
              : 'QQ group is muted',
          }
        }
      } catch {
        // 诊断失败不覆盖原始发送失败。
      }
    }
  }
  const payload = {
    ok: result.status === 'sent',
    actionId: input.actionId,
    status: result.status,
    target: input.target,
    mode: input.mode,
    providerMessageId: result.providerMessageId ?? null,
    ...(result.code ? { code: result.code } : {}),
    ...(result.error ? { error: result.error } : {}),
  }
  return {
    content: JSON.stringify(payload),
    outcome: result.status === 'sent'
      ? { ok: true }
      : { ok: false, code: result.code ?? result.status, ...(result.error ? { error: result.error } : {}) },
    ...(result.status === 'sent'
      ? {
          effects: [{
            type: 'message_sent' as const,
            target: input.target,
            ...(input.workState === 'continue' ? { continueWork: true as const } : {}),
          }],
        }
      : {}),
  }
}

function conversationError(code: 'CHAT_CONTEXT_UNAVAILABLE' | 'CHAT_CONTEXT_STALE'): ToolExecutionResult {
  const error = code === 'CHAT_CONTEXT_UNAVAILABLE'
    ? 'Open a conversation before sending.'
    : 'The current conversation is stale. Reopen the intended conversation.'
  return failedResult({ status: 'failed', code, error })
}

function failedResult(payload: Record<string, unknown>): ToolExecutionResult {
  return {
    content: JSON.stringify({ ok: false, ...payload }),
    outcome: {
      ok: false,
      code: typeof payload.code === 'string' ? payload.code : 'send_failed',
      ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
    },
  }
}

function imageRefToHandle(ref: string | null): ImageHandle | undefined {
  if (!ref) return undefined
  if (ref.startsWith('media:')) {
    const mediaId = Number(ref.slice('media:'.length))
    return Number.isSafeInteger(mediaId) && mediaId > 0 ? { mediaId } : undefined
  }
  return ref.startsWith('ephemeral:') ? { ephemeralRef: ref.slice('ephemeral:'.length) } : undefined
}
