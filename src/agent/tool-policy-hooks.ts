import { createHash } from 'node:crypto'
import type { AfterToolHook, BeforeToolHook } from './tool.js'
import { createLogger } from '../logger.js'
import { normalizeSendText } from './tools/send-message.js'
import type { ConversationFocus } from './agent-context.types.js'
import type { ConversationRef } from '../chat/conversation.js'
import { conversationKey } from '../chat/conversation.js'

const log = createLogger('TOOL_POLICY_HOOKS')

const DEFAULT_PRIVATE_AMBIENT_COOLDOWN_MS = 30 * 60_000
const DEFAULT_AMBIENT_DUPLICATE_WINDOW_MS = 12 * 60 * 60_000

export interface GenerateImageTaskLogEntry {
  toolCallId: string
  roundIndex: number
  taskId: string
  description: string
  quality?: string
  promptPreview?: string
}

interface SendMessageHookArgs {
  message?: unknown
  reply_to?: unknown
  work?: unknown
}

type SendMessageAiToneTarget = ConversationRef

interface GenerateImageHookArgs {
  prompt?: unknown
  quality?: unknown
}

interface GenerateImageStartedResult {
  ok?: unknown
  status?: unknown
  taskId?: unknown
  description?: unknown
}

interface GenerateImageTaskLogHookOptions {
  logger?: (entry: GenerateImageTaskLogEntry) => void
}

export interface SendMessageSafetyGuardOptions {
  getCurrentTarget: () => ConversationFocus
  hasPendingPrivateMailbox?: (target: ConversationRef) => boolean
  nowMs?: () => number
  privateAmbientCooldownMs?: number
  ambientDuplicateWindowMs?: number
}

export interface SendMessageSafetyGuard {
  beforeTool: BeforeToolHook
  afterTool: AfterToolHook
}

/** 只按成功主动外发计时的进程内防抖；pending mailbox 回复不受限。 */
export function createSendMessageSafetyGuard(
  options: SendMessageSafetyGuardOptions,
): SendMessageSafetyGuard {
  const nowMs = options.nowMs ?? Date.now
  const privateAmbientCooldownMs = Math.max(
    1,
    options.privateAmbientCooldownMs ?? DEFAULT_PRIVATE_AMBIENT_COOLDOWN_MS,
  )
  const ambientDuplicateWindowMs = Math.max(
    1,
    options.ambientDuplicateWindowMs ?? DEFAULT_AMBIENT_DUPLICATE_WINDOW_MS,
  )
  const lastPrivateAmbientAt = new Map<string, number>()
  const lastAmbientTextAt = new Map<string, number>()

  const beforeTool: BeforeToolHook = ({ call }) => {
    if (call.name !== 'send_message') return
    const args = call.args as SendMessageHookArgs
    const target = parseSendMessageAiToneTarget(options.getCurrentTarget())
    if (isReplySend(args, target, options.hasPendingPrivateMailbox)) return

    const now = nowMs()
    if (typeof args.message === 'string') {
      const normalized = normalizeSendText(args.message).trim()
      if (normalized.length > 0) {
        const lastAt = lastAmbientTextAt.get(hashText(normalized))
        if (lastAt != null && now - lastAt < ambientDuplicateWindowMs) {
          return rejectSendMessage(
            'ambient_duplicate',
            ambientDuplicateWindowMs - (now - lastAt),
            '这段完全相同的主动发言在 12 小时内已经成功发送过。不要换目标重复群发；有新的真实内容再发。',
          )
        }
      }
    }

    if (target?.kind !== 'private') return
    const lastAt = lastPrivateAmbientAt.get(conversationKey(target))
    if (lastAt != null && now - lastAt < privateAmbientCooldownMs) {
      return rejectSendMessage(
        'private_ambient_cooldown',
        privateAmbientCooldownMs - (now - lastAt),
        '刚刚已经主动联系过这个人，且当前没有待处理的新私聊。先让对方有回应空间；收到对方新消息后，runtime 会按 pending mailbox 识别为回复，不要传 mode。reply_to 只用于需要 QQ 引用展示时。',
      )
    }
  }

  const afterTool: AfterToolHook = ({ call, result }) => {
    if (call.name !== 'send_message') return
    const args = call.args as SendMessageHookArgs
    if (!result.effects?.some((effect) => effect.type === 'message_sent')) return

    const confirmedTarget = result.effects
      ?.find((effect) => effect.type === 'message_sent')
      ?.target
    const target = parseSendMessageAiToneTarget(confirmedTarget)
      ?? parseSendMessageAiToneTarget(options.getCurrentTarget())
    if (isReplySend(args, target, options.hasPendingPrivateMailbox)) return

    const now = nowMs()
    if (target?.kind === 'private') lastPrivateAmbientAt.set(conversationKey(target), now)
    if (typeof args.message !== 'string') return
    const normalized = normalizeSendText(args.message).trim()
    if (normalized.length > 0) lastAmbientTextAt.set(hashText(normalized), now)
  }

  return { beforeTool, afterTool }
}

function isReplySend(
  args: SendMessageHookArgs,
  target: SendMessageAiToneTarget | null,
  hasPendingPrivateMailbox: SendMessageSafetyGuardOptions['hasPendingPrivateMailbox'],
): boolean {
  if (args.reply_to != null) return true
  return target?.kind === 'private' && hasPendingPrivateMailbox?.(target) === true
}

export function createGenerateImageTaskLogHook(options: GenerateImageTaskLogHookOptions = {}): AfterToolHook {
  const logger = options.logger ?? ((entry) => log.info(entry, 'generate_image_task_started'))

  return ({ call, roundIndex, result }) => {
    if (call.name !== 'generate_image') return
    if (typeof result.content !== 'string') return

    const parsed = parseJsonObject(result.content) as GenerateImageStartedResult | null
    if (!parsed) return
    if (parsed.ok !== true || parsed.status !== 'started' || typeof parsed.taskId !== 'string') return

    const args = call.args as GenerateImageHookArgs
    const entry: GenerateImageTaskLogEntry = {
      toolCallId: call.id,
      roundIndex,
      taskId: parsed.taskId,
      description: typeof parsed.description === 'string' ? parsed.description : '',
      ...(typeof args.quality === 'string' ? { quality: args.quality } : {}),
      ...(typeof args.prompt === 'string' ? { promptPreview: preview(args.prompt, 160) } : {}),
    }
    logger(entry)
  }
}

function parseSendMessageAiToneTarget(target: unknown): SendMessageAiToneTarget | null {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null
  const value = target as Record<string, unknown>
  if (value.platform !== 'qq' && value.platform !== 'feishu') return null
  if (value.kind !== 'group' && value.kind !== 'private') return null
  if (typeof value.accountId !== 'string' || typeof value.externalId !== 'string') return null
  return {
    platform: value.platform,
    accountId: value.accountId,
    kind: value.kind,
    externalId: value.externalId,
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function preview(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function rejectSendMessage(code: string, retryAfterMs: number, instruction: string) {
  return {
    content: JSON.stringify({
      ok: false,
      status: 'rejected',
      code,
      retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)),
      instruction,
    }),
    outcome: { ok: false, code },
  }
}
