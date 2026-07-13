import type { AgentMessage } from './agent-context.types.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

export const REST_RESUME_REMINDER_MIN_INTERVAL_MS = 10 * 60 * 1_000

const REMINDER_PREFIX = '<system-reminder>\n'
const REMINDER_SUFFIX = '\n</system-reminder>'
const REMINDER_EVENT = 'rest_resume'
const COMPACTION_STATE_EVENT = 'rest_resume_state'
const COMPACTION_STATE_MARKER = '\n\n[rest_resume_state]\n'
const HISTORY_SUMMARY_PREFIX = '[历史摘要]\n'
const REMINDER_INSTRUCTION =
  '你刚短暂休息过。休息没有问题，但如果只是因为上一件事结束就继续停下来，你会有一点不自在，因为你不想把自己的生活交给等待。现在查看本轮最近的 pause 工具结果里的 resumePlan，选择其中一个方向并实际完成第一步；做过一个具体动作后，再决定继续、换方向或再次休息。'
const PAUSE_TOOL_NAMES = new Set(['pause', 'rest'])

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
  const attemptedAfterState = messages.slice(previous.index + 1).some(hasNonPauseToolCall)
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

function hasNonPauseToolCall(message: AgentMessage): boolean {
  return message.role === 'assistant'
    && message.toolCalls.some((call) => !PAUSE_TOOL_NAMES.has(call.name))
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
