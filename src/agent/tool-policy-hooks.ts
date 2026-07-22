import { createHash } from 'node:crypto'
import type { AfterToolHook, BeforeToolHook } from './tool.js'
import { createLogger } from '../logger.js'
import { normalizeSendText } from './tools/send-message.js'
import type { QqConversationFocus } from './agent-context.types.js'

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

interface SendMessageGoalBinding {
  goalId: string
  status: string
  currentCommitment: unknown
}

export interface SendMessageWorkCommitmentHookOptions {
  getCurrentGoal: () => Promise<SendMessageGoalBinding | null>
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

/** 持久 Goal 的进度外发必须绑定真实 active Goal；短期 continue 由 BotLoop 进程内承接。 */
export function createSendMessageWorkCommitmentHook(
  options: SendMessageWorkCommitmentHookOptions,
): BeforeToolHook {
  return async ({ call }) => {
    if (call.name !== 'send_message') return
    const args = call.args as SendMessageHookArgs
    const work = parseSendMessageWorkBinding(args.work)
    if (work?.state !== 'goal_progress') return

    const goal = await options.getCurrentGoal()
    if (
      goal?.goalId === work.goalId
      && goal.status === 'active'
      && goal.currentCommitment != null
    ) {
      return
    }

    const error = goal == null
      ? '进度消息承诺了后续工作，但当前没有 active Goal。'
      : goal.goalId !== work.goalId
        ? `进度消息绑定的 goalId 不是当前 Goal（current=${goal.goalId}）。`
        : goal.status !== 'active'
          ? `进度消息绑定的 Goal 状态是 ${goal.status}，不是 active。`
          : '当前 active Goal 缺少 currentCommitment。'
    return {
      content: JSON.stringify({
        ok: false,
        code: 'work_commitment_required',
        error,
        instruction: '持久工作先用 goal create_self/replan 建立具体 currentCommitment，再用其 goalId 重试；如果只是当前会话内马上续做，改用 work.state=continue；如果已无后续工作，删掉正文中的未来承诺并用 work.state=none。',
      }),
      outcome: {
        ok: false,
        code: 'work_commitment_required',
        error,
        progress: false,
        continuation: 'immediate',
      },
    }
  }
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

function parseSendMessageWorkBinding(value: unknown):
  | { state: 'none' }
  | { state: 'continue' }
  | { state: 'goal_progress'; goalId: string }
  | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const work = value as Record<string, unknown>
  if (work.state === 'none') return { state: 'none' }
  if (work.state === 'continue') return { state: 'continue' }
  if (work.state === 'goal_progress' && typeof work.goalId === 'string') {
    return { state: 'goal_progress', goalId: work.goalId }
  }
  return null
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
  if (value.type === 'group' && typeof value.groupId === 'number') {
    return { type: 'group', groupId: value.groupId }
  }
  if (value.type === 'private' && typeof value.userId === 'number') {
    return { type: 'private', userId: value.userId }
  }
  return null
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
