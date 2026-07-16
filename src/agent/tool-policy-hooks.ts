import { createHash } from 'node:crypto'
import type { AfterToolHook, BeforeToolHook } from './tool.js'
import { createLogger } from '../logger.js'
import { predictAiTone, type AiTonePrediction, type AiTonePredictor } from './tools/ai-tone.js'
import { normalizeSendText } from './tools/send-message.js'
import type { QqConversationFocus } from './agent-context.types.js'

const log = createLogger('TOOL_POLICY_HOOKS')

const DEFAULT_AI_TONE_THRESHOLD = 0.75
const DEFAULT_MAX_CONSECUTIVE_BLOCKS = 2
const DEFAULT_PRIVATE_AMBIENT_COOLDOWN_MS = 30 * 60_000
const DEFAULT_AMBIENT_DUPLICATE_WINDOW_MS = 12 * 60 * 60_000

export type AiTonePrecheckDecision = 'allowed' | 'blocked' | 'allowed_after_limit'

export interface AiTonePrecheckLogEntry {
  toolCallId: string
  roundIndex: number
  targetType: 'group' | 'private'
  groupId?: number
  userId?: number
  textLength: number
  prob: number
  threshold: number
  isAI: boolean
  decision: AiTonePrecheckDecision
  consecutiveBlocked: number
}

export interface GenerateImageTaskLogEntry {
  toolCallId: string
  roundIndex: number
  taskId: string
  description: string
  quality?: string
  promptPreview?: string
}

interface SendMessageAiToneHookOptions {
  getCurrentTarget: () => QqConversationFocus
  predict?: AiTonePredictor
  logger?: (entry: AiTonePrecheckLogEntry) => void
  threshold?: number
  maxConsecutiveBlocks?: number
}

interface SendMessageHookArgs {
  message?: unknown
  reply_to?: unknown
}

type SendMessageAiToneTarget =
  | { type: 'group'; groupId: number }
  | { type: 'private'; userId: number }

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
  getCurrentTarget: () => QqConversationFocus
  hasPendingPrivateMailbox?: (userId: number) => boolean
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
  const lastPrivateAmbientAt = new Map<number, number>()
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

    if (target?.type !== 'private') return
    const lastAt = lastPrivateAmbientAt.get(target.userId)
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
    if (target?.type === 'private') lastPrivateAmbientAt.set(target.userId, now)
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
  return target?.type === 'private' && hasPendingPrivateMailbox?.(target.userId) === true
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

export function createSendMessageAiToneHook(options: SendMessageAiToneHookOptions): BeforeToolHook {
  const predict = options.predict ?? predictAiTone
  const logger = options.logger ?? ((entry) => log.info(entry, 'send_message_ai_tone_precheck'))
  const threshold = options.threshold ?? DEFAULT_AI_TONE_THRESHOLD
  const maxConsecutiveBlocks = options.maxConsecutiveBlocks ?? DEFAULT_MAX_CONSECUTIVE_BLOCKS
  const consecutiveBlockedByTarget = new Map<string, number>()

  return async ({ call, roundIndex }) => {
    if (call.name !== 'send_message') return

    const args = call.args as SendMessageHookArgs
    if (typeof args.message !== 'string') return
    const target = parseSendMessageAiToneTarget(options.getCurrentTarget())
    if (!target) return

    const textLength = Array.from(args.message).length

    const prediction = await predict(args.message, threshold)
    const targetKey = buildTargetKey(target)
    const currentBlocked = consecutiveBlockedByTarget.get(targetKey) ?? 0

    if (!prediction.isAI) {
      consecutiveBlockedByTarget.delete(targetKey)
      logger(buildLogEntry({
        callId: call.id,
        roundIndex,
        target,
        textLength,
        prediction,
        decision: 'allowed',
        consecutiveBlocked: 0,
      }))
      return
    }

    if (currentBlocked >= maxConsecutiveBlocks) {
      logger(buildLogEntry({
        callId: call.id,
        roundIndex,
        target,
        textLength,
        prediction,
        decision: 'allowed_after_limit',
        consecutiveBlocked: currentBlocked,
      }))
      return
    }

    const nextBlocked = currentBlocked + 1
    consecutiveBlockedByTarget.set(targetKey, nextBlocked)
    logger(buildLogEntry({
      callId: call.id,
      roundIndex,
      target,
      textLength,
      prediction,
      decision: 'blocked',
      consecutiveBlocked: nextBlocked,
    }))

    return {
      content: JSON.stringify({
        ok: false,
        error: 'ai_tone_precheck_failed',
        prob: roundPredictionNumber(prediction.prob),
        threshold: prediction.threshold,
        consecutiveBlocked: nextBlocked,
        instruction: '这条发言 AI 味太重。请改成更短、更具体、更像真人随口说的话，然后重新调用 send_message。',
      }),
    }
  }
}

export const createGroupSendAiToneHook = createSendMessageAiToneHook

function parseSendMessageAiToneTarget(target: unknown): SendMessageAiToneTarget | null {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null
  const value = target as Record<string, unknown>
  if (value.type === 'group' && typeof value.groupId === 'number') {
    return { type: 'group', groupId: value.groupId }
  }
  if (value.type === 'private' && typeof value.userId === 'number') {
    return { type: 'private', userId: value.userId }
  }
  return null
}

function buildTargetKey(target: SendMessageAiToneTarget): string {
  return target.type === 'group' ? `group:${target.groupId}` : `private:${target.userId}`
}

function buildLogEntry(input: {
  callId: string
  roundIndex: number
  target: SendMessageAiToneTarget
  textLength: number
  prediction: AiTonePrediction
  decision: AiTonePrecheckDecision
  consecutiveBlocked: number
}): AiTonePrecheckLogEntry {
  return {
    toolCallId: input.callId,
    roundIndex: input.roundIndex,
    targetType: input.target.type,
    ...(input.target.type === 'group' ? { groupId: input.target.groupId } : { userId: input.target.userId }),
    textLength: input.textLength,
    prob: roundPredictionNumber(input.prediction.prob),
    threshold: input.prediction.threshold,
    isAI: input.prediction.isAI,
    decision: input.decision,
    consecutiveBlocked: input.consecutiveBlocked,
  }
}

function roundPredictionNumber(value: number): number {
  return Math.round(value * 1000) / 1000
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
