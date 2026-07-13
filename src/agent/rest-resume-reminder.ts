import type { AgentMessage, ToolResultContent } from './agent-context.types.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

export const REST_RESUME_REMINDER_MIN_INTERVAL_MS = 10 * 60 * 1_000

const REMINDER_PREFIX = '<system-reminder>\n'
const REMINDER_SUFFIX = '\n</system-reminder>'
const REMINDER_EVENT = 'rest_resume'
const COMPACTION_STATE_EVENT = 'rest_resume_state'
const COMPACTION_STATE_MARKER = '\n\n[rest_resume_state]\n'
const HISTORY_SUMMARY_PREFIX = '[历史摘要]\n'
const REMINDER_INSTRUCTION =
  '你刚短暂休息过。休息没有问题，但你不想把自己的生活交给等待。现在查看本轮最近的 pause 工具结果里的 resumePlan，先实际完成 primaryDirection 的第一步；若它已失去吸引力就改做 alternativeDirection。做过一个具体动作后，再决定继续、换方向或再次休息。'
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
