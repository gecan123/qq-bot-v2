import type { PersistedAgentSnapshot } from './agent-context.types.js'
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
  const snapshot = input.snapshot as unknown as Record<string, unknown>
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : []
  const activeToolCapabilities = Array.isArray(snapshot.activeToolCapabilities)
    ? snapshot.activeToolCapabilities
    : []
  const mailboxCursors = normalizeCursorEntries(input.mailboxCursors, errors)

  validateStableJson(input.snapshot, errors)
  if (!Number.isSafeInteger(snapshot.schemaVersion) || (snapshot.schemaVersion as number) < 1) {
    errors.push('snapshot.schemaVersion must be a positive safe integer')
  }
  if (!Array.isArray(snapshot.messages)) {
    errors.push('snapshot.messages must be an array')
  }
  if (!Array.isArray(snapshot.activeToolCapabilities)) {
    errors.push('snapshot.activeToolCapabilities must be an array')
  }
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
        if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.toolCalls)) {
          return count
        }
        return count + message.toolCalls.length
      }, 0),
      toolResults: messages.filter((message) => isRecord(message) && message.role === 'tool').length,
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

function validateMessages(messages: unknown[], errors: string[], warnings: string[]): void {
  const expectedToolCallIds = new Set<string>()
  const consumedToolResultIds = new Set<string>()
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!isRecord(message)) {
      errors.push(`messages[${index}] must be an object`)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(message, 'activeToolCapabilities')) {
      errors.push(`messages[${index}] must not contain activeToolCapabilities`)
    }

    if (message.role === 'user') {
      if (typeof message.content !== 'string') {
        errors.push(`messages[${index}].content must be a string`)
      }
      continue
    }

    if (message.role === 'assistant') {
      if (typeof message.content !== 'string') {
        errors.push(`messages[${index}].content must be a string`)
      } else if (message.content.length > 0) {
        warnings.push(`messages[${index}] assistant content is non-empty`)
      }
      if (!Array.isArray(message.toolCalls)) {
        errors.push(`messages[${index}].toolCalls must be an array`)
        continue
      }
      for (let offset = 0; offset < message.toolCalls.length; offset++) {
        const call = message.toolCalls[offset]
        if (!isRecord(call)) {
          errors.push(`messages[${index}].toolCalls[${offset}] must be an object`)
          continue
        }
        const callId = typeof call.id === 'string' && call.id.trim() ? call.id : null
        if (!callId) {
          errors.push(`messages[${index}].toolCalls[${offset}].id must be a non-empty string`)
          continue
        }
        if (typeof call.name !== 'string' || !call.name.trim()) {
          errors.push(`messages[${index}].toolCalls[${offset}].name must be a non-empty string`)
        }
        if (!isRecord(call.args)) {
          errors.push(`messages[${index}].toolCalls[${offset}].args must be an object`)
        }
        if (expectedToolCallIds.has(callId)) {
          errors.push(`messages[${index}] duplicate assistant tool call id ${callId}`)
        }
        expectedToolCallIds.add(callId)
        const toolIndex = index + offset + 1
        const toolMessage = messages[toolIndex]
        if (!isRecord(toolMessage) || toolMessage.role !== 'tool' || toolMessage.toolCallId !== callId) {
          errors.push(`messages[${toolIndex}] must be tool result for assistant tool call ${callId}`)
          continue
        }
        if (consumedToolResultIds.has(callId)) {
          errors.push(`messages[${toolIndex}] is duplicate tool result ${callId}`)
          continue
        }
        consumedToolResultIds.add(callId)
        validateToolContent(toolMessage.content, toolIndex, errors)
      }
      index += message.toolCalls.length
      continue
    }

    if (message.role === 'tool') {
      const toolCallId = typeof message.toolCallId === 'string' && message.toolCallId.trim()
        ? message.toolCallId
        : null
      if (!toolCallId) {
        errors.push(`messages[${index}].toolCallId must be a non-empty string`)
      } else if (!expectedToolCallIds.has(toolCallId)) {
        errors.push(`messages[${index}] is orphan tool result ${toolCallId}`)
      } else if (consumedToolResultIds.has(toolCallId)) {
        errors.push(`messages[${index}] is duplicate tool result ${toolCallId}`)
      } else {
        errors.push(`messages[${index}] is non-adjacent tool result ${toolCallId}`)
        consumedToolResultIds.add(toolCallId)
      }
      validateToolContent(message.content, index, errors)
      continue
    }

    errors.push(`messages[${index}].role must be user, assistant, or tool`)
  }
}

function validateToolContent(content: unknown, index: number, errors: string[]): void {
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

  if (!Array.isArray(content)) {
    errors.push(`messages[${index}].content must be a string or content block array`)
    return
  }
  for (const [blockIndex, block] of content.entries()) {
    if (!isRecord(block)) {
      errors.push(`messages[${index}].content[${blockIndex}] must be an object`)
      continue
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        errors.push(`messages[${index}].content[${blockIndex}].text must be a string`)
      }
      continue
    }
    if (block.type !== 'image' || !isRecord(block.source)) {
      errors.push(`messages[${index}].content[${blockIndex}] must be a text or image block`)
      continue
    }
    if (block.source.type !== 'base64') {
      errors.push(`messages[${index}].content[${blockIndex}] image source type must be base64`)
    }
    if (!block.source.media_type || !block.source.data) {
      errors.push(`messages[${index}].content[${blockIndex}] image source must include media_type and data`)
    }
  }
}

function normalizeCursorEntries(value: unknown, errors: string[]): Array<[string, unknown]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('mailboxCursors must be an object')
    return []
  }
  return Object.entries(value as MailboxCursors)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
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
