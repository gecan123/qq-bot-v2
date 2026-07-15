import type { AgentMessage, ToolResultContent } from './agent-context.types.js'
import type { RestResumeCompactionState } from './agent-ledger.types.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

export const REST_RESUME_REMINDER_MIN_INTERVAL_MS = 10 * 60 * 1_000

const REMINDER_PREFIX = '<system-reminder>\n'
const REMINDER_SUFFIX = '\n</system-reminder>'
const REMINDER_EVENT = 'rest_resume'
const INTERRUPTED_ATTENTION_EVENT = 'rest_interrupted_attention'
const COMPACTION_STATE_EVENT = 'rest_resume_state'
const COMPACTION_STATE_MARKER = '\n\n[rest_resume_state]\n'
const HISTORY_SUMMARY_PREFIX = '[历史摘要]\n'
const REMINDER_INSTRUCTION =
  '你刚短暂休息过。现在重新查看本轮最近的 pause 工具结果里的 resumePlan：primaryDirection 仍有吸引力就完成第一步，失去吸引力再看 alternativeDirection；若两者都已失效、也没有未处理义务，可以自然结束当前活动轮。不要为证明醒来后有行动而写 Journal、发消息或再次休息来表演收尾。'
const INTERRUPTED_ATTENTION_INSTRUCTION =
  '最近一次 pause 被本轮注意事件打断。先处理 priority=high 私聊、@、审批或其他真实注意事件；这只是临时切换，不会自动取消自己的方向。处理后重新查看最近 pause 工具结果里的 resumePlan：仍相关就回到 primaryDirection，已失去吸引力再改道。'
const PAUSE_TOOL_NAMES = new Set(['pause', 'rest'])
const META_ONLY_TOOL_NAMES = new Set(['help'])

interface RestResumeReminderPayload {
  event: typeof REMINDER_EVENT
  emittedAt: string
  instruction: string
}

interface RestResumeCompactionStatePayload {
  event: typeof COMPACTION_STATE_EVENT
  emittedAt: string
  nonPauseActionSince: boolean
}

interface RestResumeReminderState {
  index: number
  emittedAt: string
  emittedAtMs: number
  nonPauseActionSince: boolean
}

export function renderRestResumeReminder(now: Date): string {
  const payload: RestResumeReminderPayload = {
    event: REMINDER_EVENT,
    emittedAt: formatBeijingIso(now),
    instruction: REMINDER_INSTRUCTION,
  }
  return `${REMINDER_PREFIX}${JSON.stringify(payload)}${REMINDER_SUFFIX}`
}

export function renderInterruptedRestAttentionReminder(): string {
  return `${REMINDER_PREFIX}${JSON.stringify({
    event: INTERRUPTED_ATTENTION_EVENT,
    instruction: INTERRUPTED_ATTENTION_INSTRUCTION,
  })}${REMINDER_SUFFIX}`
}

/**
 * 高优事件已经进入 ledger、但主 Agent 尚未开始处理时，提醒一次短活动仍可恢复。
 * 判定只读取 durable ledger：最近一次已闭合工具结果必须是 interrupted pause/rest，
 * 且此后只能有 user-role 事件，不能已有 assistant 行动或同类提醒。
 */
export function shouldAppendInterruptedRestAttentionReminder(
  messages: readonly AgentMessage[],
): boolean {
  let toolIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'assistant') return false
    if (message?.role === 'user' && isInterruptedAttentionReminder(message.content)) return false
    if (message?.role === 'tool') {
      toolIndex = index
      break
    }
  }
  if (toolIndex < 0) return false

  const toolMessage = messages[toolIndex]
  if (toolMessage?.role !== 'tool' || !isInterruptedRestResult(toolMessage.content)) return false
  for (let index = toolIndex - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const call = message.toolCalls.find((item) => item.id === toolMessage.toolCallId)
    return call != null && PAUSE_TOOL_NAMES.has(call.name)
  }
  return false
}

export function shouldAppendRestResumeReminder(
  messages: readonly AgentMessage[],
  now: Date,
): boolean {
  const previous = captureRestResumeReminderState(messages)
  if (!previous) return true

  if (!previous.nonPauseActionSince) return false

  return now.getTime() - previous.emittedAtMs >= REST_RESUME_REMINDER_MIN_INTERVAL_MS
}

export function renderRestResumeReminderCompactionSuffix(
  messages: readonly AgentMessage[],
): string {
  const state = captureRestResumeReminderState(messages)
  if (!state) return ''
  const payload: RestResumeCompactionStatePayload = {
    event: COMPACTION_STATE_EVENT,
    emittedAt: state.emittedAt,
    nonPauseActionSince: state.nonPauseActionSince,
  }
  return `${COMPACTION_STATE_MARKER}${JSON.stringify(payload)}`
}

export function captureRestResumeCompactionState(
  messages: readonly AgentMessage[],
): RestResumeCompactionState | null {
  const state = captureRestResumeReminderState(messages)
  return state == null
    ? null
    : { emittedAt: state.emittedAt, nonPauseActionSince: state.nonPauseActionSince }
}

export function stripRestResumeReminderCompactionSuffix(content: string): string {
  if (!content.startsWith(HISTORY_SUMMARY_PREFIX)) return content
  const markerIndex = content.lastIndexOf(COMPACTION_STATE_MARKER)
  return markerIndex >= HISTORY_SUMMARY_PREFIX.length ? content.slice(0, markerIndex) : content
}

function captureRestResumeReminderState(
  messages: readonly AgentMessage[],
): RestResumeReminderState | null {
  const previous = findLatestReminderState(messages)
  if (!previous) return null
  const attemptedAfterState = hasSuccessfulNonPauseToolResult(messages.slice(previous.index + 1))
  return {
    ...previous,
    nonPauseActionSince: previous.nonPauseActionSince || attemptedAfterState,
  }
}

function findLatestReminderState(
  messages: readonly AgentMessage[],
): RestResumeReminderState | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const reminder = parseReminderPayload(message.content)
    if (reminder) {
      return {
        index,
        emittedAt: reminder.emittedAt,
        emittedAtMs: Date.parse(reminder.emittedAt),
        nonPauseActionSince: false,
      }
    }
    const compacted = parseCompactionStatePayload(message.content)?.payload
    if (compacted) {
      return {
        index,
        emittedAt: compacted.emittedAt,
        emittedAtMs: Date.parse(compacted.emittedAt),
        nonPauseActionSince: compacted.nonPauseActionSince,
      }
    }
  }
  return null
}

function hasSuccessfulNonPauseToolResult(messages: readonly AgentMessage[]): boolean {
  const candidateCallIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) {
        if (!PAUSE_TOOL_NAMES.has(call.name) && !META_ONLY_TOOL_NAMES.has(call.name)) {
          candidateCallIds.add(call.id)
        }
      }
      continue
    }
    if (message.role === 'tool' && candidateCallIds.has(message.toolCallId) && toolResultSucceeded(message.content)) {
      return true
    }
  }
  return false
}

function toolResultSucceeded(content: ToolResultContent): boolean {
  if (typeof content !== 'string') return true
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true
    const result = parsed as Record<string, unknown>
    return result.ok !== false && result.success !== false
  } catch {
    return true
  }
}

function isInterruptedRestResult(content: ToolResultContent): boolean {
  if (typeof content !== 'string') return false
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const result = parsed as Record<string, unknown>
    return result.ok === true && result.status === 'interrupted' && result.resumePlan != null
  } catch {
    return false
  }
}

function isInterruptedAttentionReminder(content: string): boolean {
  if (!content.startsWith(REMINDER_PREFIX) || !content.endsWith(REMINDER_SUFFIX)) return false
  try {
    const value = JSON.parse(
      content.slice(REMINDER_PREFIX.length, -REMINDER_SUFFIX.length),
    ) as Record<string, unknown>
    return value.event === INTERRUPTED_ATTENTION_EVENT
      && value.instruction === INTERRUPTED_ATTENTION_INSTRUCTION
  } catch {
    return false
  }
}

function parseReminderPayload(content: string): RestResumeReminderPayload | null {
  if (!content.startsWith(REMINDER_PREFIX) || !content.endsWith(REMINDER_SUFFIX)) return null
  const json = content.slice(REMINDER_PREFIX.length, -REMINDER_SUFFIX.length)
  try {
    const value = JSON.parse(json) as Record<string, unknown>
    if (value.event !== REMINDER_EVENT || typeof value.emittedAt !== 'string') return null
    if (!Number.isFinite(Date.parse(value.emittedAt))) return null
    if (value.instruction !== REMINDER_INSTRUCTION) return null
    return value as unknown as RestResumeReminderPayload
  } catch {
    return null
  }
}

function parseCompactionStatePayload(content: string): {
  markerIndex: number
  payload: RestResumeCompactionStatePayload
} | null {
  if (!content.startsWith(HISTORY_SUMMARY_PREFIX)) return null
  const markerIndex = content.lastIndexOf(COMPACTION_STATE_MARKER)
  if (markerIndex < HISTORY_SUMMARY_PREFIX.length) return null
  const json = content.slice(markerIndex + COMPACTION_STATE_MARKER.length)
  try {
    const value = JSON.parse(json) as Record<string, unknown>
    if (value.event !== COMPACTION_STATE_EVENT || typeof value.emittedAt !== 'string') return null
    if (!Number.isFinite(Date.parse(value.emittedAt))) return null
    if (typeof value.nonPauseActionSince !== 'boolean') return null
    return {
      markerIndex,
      payload: value as unknown as RestResumeCompactionStatePayload,
    }
  } catch {
    return null
  }
}
