import type { AgentMessage, PersistedAgentSnapshot, ToolResultContent } from './agent-context.types.js'
import type { MailboxCursors } from './mailbox.js'

export interface BotSnapshotIntegrityInput {
  snapshot: PersistedAgentSnapshot
  mailboxCursors: unknown
  mailboxContinuity?: unknown
  goalRevision: unknown
}

export interface BotSnapshotIntegrityResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  stats: {
    messages: number
    assistantToolCalls: number
    toolResults: number
    activeToolCapabilities: number
    mailboxCursors: number
    goalRevision: number
  }
}

export function validateBotSnapshotIntegrity(input: BotSnapshotIntegrityInput): BotSnapshotIntegrityResult {
  const errors: string[] = []
  const warnings: string[] = []
  const messages = Array.isArray(input.snapshot.messages) ? input.snapshot.messages : []
  const activeToolCapabilities = Array.isArray(input.snapshot.activeToolCapabilities)
    ? input.snapshot.activeToolCapabilities
    : []
  const mailboxCursors = normalizeCursorEntries(input.mailboxCursors)

  validateStableJson(input.snapshot, errors)
  validateActiveCapabilities(activeToolCapabilities, errors)
  validateMessages(messages, errors, warnings)
  validateMailboxCursors(mailboxCursors, errors)
  validateMailboxContinuity(input.mailboxContinuity, errors)
  const goalRevision = validateGoalRevision(input.goalRevision, errors)

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      messages: messages.length,
      assistantToolCalls: messages.reduce((count, message) => {
        return count + (message.role === 'assistant' ? message.toolCalls.length : 0)
      }, 0),
      toolResults: messages.filter((message) => message.role === 'tool').length,
      activeToolCapabilities: activeToolCapabilities.length,
      mailboxCursors: mailboxCursors.length,
      goalRevision,
    },
  }
}

function validateGoalRevision(value: unknown, errors: string[]): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    errors.push('goalRevision must be a non-negative safe integer')
    return 0
  }
  return value as number
}

function validateStableJson(snapshot: PersistedAgentSnapshot, errors: string[]): void {
  try {
    JSON.stringify(snapshot)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    errors.push(`snapshot is not JSON-serializable: ${message}`)
  }
}

function validateActiveCapabilities(values: unknown[], errors: string[]): void {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`activeToolCapabilities[${index}] must be a non-empty string`)
      continue
    }
    if (seen.has(value)) {
      errors.push(`activeToolCapabilities[${index}] duplicates ${value}`)
    }
    seen.add(value)
  }
}

function validateMessages(messages: AgentMessage[], errors: string[], warnings: string[]): void {
  const expectedToolCallIds = new Set<string>()
  const consumedToolResultIds = new Set<string>()
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (Object.prototype.hasOwnProperty.call(message, 'activeToolCapabilities')) {
      errors.push(`messages[${index}] must not contain activeToolCapabilities`)
    }

    if (message.role === 'assistant') {
      if (message.content.length > 0) {
        warnings.push(`messages[${index}] assistant content is non-empty`)
      }
      for (let offset = 0; offset < message.toolCalls.length; offset++) {
        const call = message.toolCalls[offset]
        if (expectedToolCallIds.has(call.id)) {
          errors.push(`messages[${index}] duplicate assistant tool call id ${call.id}`)
        }
        expectedToolCallIds.add(call.id)
        const toolIndex = index + offset + 1
        const toolMessage = messages[toolIndex]
        if (!toolMessage || toolMessage.role !== 'tool' || toolMessage.toolCallId !== call.id) {
          errors.push(`messages[${toolIndex}] must be tool result for assistant tool call ${call.id}`)
          continue
        }
        if (consumedToolResultIds.has(call.id)) {
          errors.push(`messages[${toolIndex}] is duplicate tool result ${call.id}`)
          continue
        }
        consumedToolResultIds.add(call.id)
        validateToolContent(toolMessage.content, toolIndex, errors)
      }
      index += message.toolCalls.length
      continue
    }

    if (message.role === 'tool') {
      if (!expectedToolCallIds.has(message.toolCallId)) {
        errors.push(`messages[${index}] is orphan tool result ${message.toolCallId}`)
      } else if (consumedToolResultIds.has(message.toolCallId)) {
        errors.push(`messages[${index}] is duplicate tool result ${message.toolCallId}`)
      } else {
        errors.push(`messages[${index}] is non-adjacent tool result ${message.toolCallId}`)
        consumedToolResultIds.add(message.toolCallId)
      }
      validateToolContent(message.content, index, errors)
    }
  }
}

function validateToolContent(content: ToolResultContent, index: number, errors: string[]): void {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push(`messages[${index}] tool JSON content is invalid: ${message}`)
      }
    }
    return
  }

  for (const [blockIndex, block] of content.entries()) {
    if (block.type === 'text') continue
    if (block.source.type !== 'base64') {
      errors.push(`messages[${index}].content[${blockIndex}] image source type must be base64`)
    }
    if (!block.source.media_type || !block.source.data) {
      errors.push(`messages[${index}].content[${blockIndex}] image source must include media_type and data`)
    }
  }
}

function normalizeCursorEntries(value: unknown): Array<[string, unknown]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as MailboxCursors)
}

function validateMailboxCursors(entries: Array<[string, unknown]>, errors: string[]): void {
  for (const [key, value] of entries) {
    if (!/^qq_(?:group|private):\d+$/.test(key)) {
      errors.push(`mailboxCursors.${key} has invalid key`)
    }
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      errors.push(`mailboxCursors.${key} must be a non-negative safe integer`)
    }
  }
}

function validateMailboxContinuity(value: unknown, errors: string[]): void {
  if (value == null) return
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push('mailboxContinuity must be an object')
    return
  }
  const obj = value as Record<string, unknown>
  for (const field of ['roundSeq', 'compactionEpoch']) {
    const fieldValue = obj[field]
    if (fieldValue != null && (!Number.isSafeInteger(fieldValue) || (fieldValue as number) < 0)) {
      errors.push(`mailboxContinuity.${field} must be a non-negative safe integer`)
    }
  }
  const lastInputTokens = obj.lastInputTokens
  if (lastInputTokens != null && (!Number.isSafeInteger(lastInputTokens) || (lastInputTokens as number) < 0)) {
    errors.push('mailboxContinuity.lastInputTokens must be null or a non-negative safe integer')
  }
  const mailboxes = obj.mailboxes
  if (mailboxes == null) return
  if (typeof mailboxes !== 'object' || Array.isArray(mailboxes)) {
    errors.push('mailboxContinuity.mailboxes must be an object')
    return
  }
  for (const [key, anchor] of Object.entries(mailboxes as Record<string, unknown>)) {
    if (!/^qq_(?:group|private):\d+$/.test(key)) {
      errors.push(`mailboxContinuity.mailboxes.${key} has invalid key`)
      continue
    }
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
      errors.push(`mailboxContinuity.mailboxes.${key} must be an object`)
      continue
    }
    const anchorObj = anchor as Record<string, unknown>
    for (const field of ['lastMessageAtMs', 'roundSeq', 'compactionEpoch']) {
      const fieldValue = anchorObj[field]
      if (!Number.isSafeInteger(fieldValue) || (fieldValue as number) < 0) {
        errors.push(`mailboxContinuity.mailboxes.${key}.${field} must be a non-negative safe integer`)
      }
    }
    const inputTokens = anchorObj.inputTokens
    if (inputTokens != null && (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0)) {
      errors.push(`mailboxContinuity.mailboxes.${key}.inputTokens must be null or a non-negative safe integer`)
    }
  }
}
