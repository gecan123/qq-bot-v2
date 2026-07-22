import {
  SNAPSHOT_SCHEMA_VERSION,
  type ClaudeAssistantNativeBlock,
  type DurableAgentMessage,
  type DurableToolResultContent,
  type DurableToolResultContentBlock,
} from './agent-context.types.js'
import {
  AGENT_LEDGER_SCHEMA_VERSION,
  AGENT_RUNTIME_STATE_SCHEMA_VERSION,
  type AgentLedgerEntry,
  type AgentLedgerProjection,
  type AgentRuntimeState,
  type CompactionAgentLedgerEntry,
  type CompactionLedgerPayload,
  type MessageAgentLedgerEntry,
  type RestResumeCompactionState,
} from './agent-ledger.types.js'
import { renderMailboxAttentionStateEvent, type MailboxAttentionState } from './mailbox-handled.js'
import { parseInboxReadCursors } from './inbox-read-cursors.js'
import { validateBotSnapshotIntegrity } from './snapshot-integrity.js'

const HISTORY_SUMMARY_PREFIX = '[历史摘要]\n'
const REST_STATE_MARKER = '\n\n[rest_resume_state]\n'
const MAILBOX_KEY_PATTERN = /^qq_(?:group|private):\d+$/
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d*$/

export class AgentLedgerIntegrityError extends Error {
  readonly errors: string[]

  constructor(errors: string[] | string) {
    const normalized = typeof errors === 'string' ? [errors] : [...errors]
    super(`agent ledger integrity validation failed: ${normalized.join('; ')}`)
    this.name = 'AgentLedgerIntegrityError'
    this.errors = normalized
  }
}

export function projectAgentLedger(input: {
  entries: readonly AgentLedgerEntry[]
  runtimeState: AgentRuntimeState
}): AgentLedgerProjection {
  const entries = input.entries.map((entry, index) => parseAgentLedgerEntry(entry, index))
  assertStrictlyIncreasingIds(entries)
  const throughEntryId = entries.at(-1)?.id ?? null
  const runtimeState = parseAgentRuntimeState(input.runtimeState)
  if (runtimeState.ledgerHeadEntryId !== throughEntryId) {
    throw new AgentLedgerIntegrityError(
      `runtime ledger head ${formatEntryId(runtimeState.ledgerHeadEntryId)}`
      + ` does not match canonical head ${formatEntryId(throughEntryId)}`,
    )
  }

  const allMessages = entries
    .filter((entry): entry is MessageAgentLedgerEntry => entry.entryType === 'message')
    .map((entry) => entry.payload.message)
  assertSnapshotIntegrity(allMessages, runtimeState, 'permanent ledger')

  const latestCompaction = validateCompactionChain(entries)
  const activeMessages = selectActiveMessages(entries, latestCompaction)
  const projectedMessages = latestCompaction == null
    ? activeMessages
    : [
        renderSummaryMessage(latestCompaction.payload),
        ...renderMachineStateMessages(latestCompaction.payload),
        ...activeMessages,
      ]

  assertSnapshotIntegrity(projectedMessages, runtimeState, 'active projection')

  return {
    throughEntryId,
    activeEntryCount: activeMessages.length,
    permanentEntryCount: entries.length,
    snapshot: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      messages: projectedMessages,
      qqConversationFocus: runtimeState.qqConversationFocus,
    },
  }
}

export function parseAgentLedgerEntry(value: unknown, index = 0): AgentLedgerEntry {
  const path = `entries[${index}]`
  const entry = requireRecord(value, path)
  requireExactKeys(entry, ['id', 'entryType', 'payload', 'createdAt'], [], path)
  if (typeof entry.id !== 'bigint' || entry.id <= 0n) {
    throw new AgentLedgerIntegrityError(`${path}.id must be a positive bigint`)
  }
  if (!(entry.createdAt instanceof Date) || !Number.isFinite(entry.createdAt.getTime())) {
    throw new AgentLedgerIntegrityError(`${path}.createdAt must be a valid Date`)
  }
  if (entry.entryType === 'message') {
    return {
      id: entry.id,
      entryType: 'message',
      payload: parseMessagePayload(entry.payload, `${path}.payload`),
      createdAt: new Date(entry.createdAt.getTime()),
    }
  }
  if (entry.entryType === 'compaction') {
    return {
      id: entry.id,
      entryType: 'compaction',
      payload: parseCompactionPayload(entry.payload, `${path}.payload`),
      createdAt: new Date(entry.createdAt.getTime()),
    }
  }
  throw new AgentLedgerIntegrityError(`${path} has unknown entry type: ${String(entry.entryType)}`)
}

function parseMessagePayload(value: unknown, path: string): MessageAgentLedgerEntry['payload'] {
  const payload = requireRecord(value, path)
  requireExactKeys(payload, ['schemaVersion', 'message'], [], path)
  if (payload.schemaVersion !== AGENT_LEDGER_SCHEMA_VERSION) {
    throw new AgentLedgerIntegrityError(
      `${path} has unsupported message schemaVersion: ${String(payload.schemaVersion)}`,
    )
  }
  return {
    schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
    message: parseDurableAgentMessage(payload.message, `${path}.message`),
  }
}

function parseCompactionPayload(value: unknown, path: string): CompactionLedgerPayload {
  const payload = requireRecord(value, path)
  requireExactKeys(payload, [
    'schemaVersion',
    'summary',
    'firstKeptEntryId',
    'tokensBefore',
    'estimatedTokensAfter',
    'reason',
    'isSplitTurn',
    'previousCompactionEntryId',
    'mailboxAttentionState',
    'restResumeState',
  ], ['manualFocus'], path)
  if (payload.schemaVersion !== AGENT_LEDGER_SCHEMA_VERSION) {
    throw new AgentLedgerIntegrityError(
      `${path} has unsupported compaction schemaVersion: ${String(payload.schemaVersion)}`,
    )
  }
  if (typeof payload.summary !== 'string' || payload.summary.trim() === '') {
    throw new AgentLedgerIntegrityError(`${path}.summary must be a non-empty string`)
  }
  const reason = payload.reason
  if (reason !== 'threshold' && reason !== 'overflow' && reason !== 'manual') {
    throw new AgentLedgerIntegrityError(`${path}.reason is unsupported: ${String(reason)}`)
  }
  if (typeof payload.isSplitTurn !== 'boolean') {
    throw new AgentLedgerIntegrityError(`${path}.isSplitTurn must be boolean`)
  }
  const manualFocus = payload.manualFocus
  if (manualFocus !== undefined && (typeof manualFocus !== 'string' || manualFocus.trim() === '')) {
    throw new AgentLedgerIntegrityError(`${path}.manualFocus must be a non-empty string when present`)
  }
  return {
    schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
    summary: payload.summary,
    firstKeptEntryId: parseNullableEntryId(payload.firstKeptEntryId, `${path}.firstKeptEntryId`),
    tokensBefore: requireNonNegativeSafeInteger(payload.tokensBefore, `${path}.tokensBefore`),
    estimatedTokensAfter: requireNonNegativeSafeInteger(
      payload.estimatedTokensAfter,
      `${path}.estimatedTokensAfter`,
    ),
    reason,
    isSplitTurn: payload.isSplitTurn,
    previousCompactionEntryId: parseNullableEntryId(
      payload.previousCompactionEntryId,
      `${path}.previousCompactionEntryId`,
    ),
    mailboxAttentionState: parseMailboxAttentionState(
      payload.mailboxAttentionState,
      `${path}.mailboxAttentionState`,
    ),
    restResumeState: parseRestResumeState(payload.restResumeState, `${path}.restResumeState`),
    ...(manualFocus === undefined ? {} : { manualFocus }),
  }
}

export function parseAgentRuntimeState(value: unknown): AgentRuntimeState {
  const path = 'runtimeState'
  const state = requireRecord(value, path)
  requireExactKeys(state, [
    'schemaVersion',
    'mailboxCursors',
    'inboxReadCursors',
    'mailboxContinuity',
    'goalRevision',
    'qqConversationFocus',
    'lastWakeAt',
    'ledgerHeadEntryId',
  ], [], path)
  if (state.schemaVersion !== AGENT_RUNTIME_STATE_SCHEMA_VERSION) {
    throw new AgentLedgerIntegrityError(
      `${path} has unsupported schemaVersion: ${String(state.schemaVersion)}`,
    )
  }
  if (state.lastWakeAt !== null && (
    !(state.lastWakeAt instanceof Date) || !Number.isFinite(state.lastWakeAt.getTime())
  )) {
    throw new AgentLedgerIntegrityError(`${path}.lastWakeAt must be a valid Date or null`)
  }
  if (state.ledgerHeadEntryId !== null && (
    typeof state.ledgerHeadEntryId !== 'bigint' || state.ledgerHeadEntryId <= 0n
  )) {
    throw new AgentLedgerIntegrityError(`${path}.ledgerHeadEntryId must be a positive bigint or null`)
  }
  let inboxReadCursors: AgentRuntimeState['inboxReadCursors']
  try {
    inboxReadCursors = parseInboxReadCursors(state.inboxReadCursors)
  } catch (error) {
    throw new AgentLedgerIntegrityError(
      `${path}.inboxReadCursors is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return {
    schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
    mailboxCursors: cloneJsonObject(state.mailboxCursors, `${path}.mailboxCursors`) as AgentRuntimeState['mailboxCursors'],
    inboxReadCursors,
    mailboxContinuity: cloneJsonObject(
      state.mailboxContinuity,
      `${path}.mailboxContinuity`,
    ) as unknown as AgentRuntimeState['mailboxContinuity'],
    goalRevision: requireNonNegativeSafeInteger(state.goalRevision, `${path}.goalRevision`),
    qqConversationFocus: parseQqConversationFocus(
      state.qqConversationFocus,
      `${path}.qqConversationFocus`,
    ),
    lastWakeAt: state.lastWakeAt == null ? null : new Date(state.lastWakeAt.getTime()),
    ledgerHeadEntryId: state.ledgerHeadEntryId,
  }
}

function parseQqConversationFocus(value: unknown, path: string): AgentRuntimeState['qqConversationFocus'] {
  if (value === null) return null
  const focus = requireRecord(value, path)
  if (focus.type === 'group') {
    requireExactKeys(focus, ['type', 'groupId'], [], path)
    return { type: 'group', groupId: requirePositiveSafeInteger(focus.groupId, `${path}.groupId`) }
  }
  if (focus.type === 'private') {
    requireExactKeys(focus, ['type', 'userId'], [], path)
    return { type: 'private', userId: requirePositiveSafeInteger(focus.userId, `${path}.userId`) }
  }
  throw new AgentLedgerIntegrityError(`${path}.type must be group or private`)
}

function parseDurableAgentMessage(value: unknown, path: string): DurableAgentMessage {
  const message = requireRecord(value, path)
  if (message.role === 'user') {
    requireExactKeys(message, ['role', 'content'], [], path)
    if (typeof message.content !== 'string') {
      throw new AgentLedgerIntegrityError(`${path}.content must be a string`)
    }
    return { role: 'user', content: message.content }
  }
  if (message.role === 'assistant') {
    requireExactKeys(message, ['role', 'content', 'toolCalls'], ['nativeBlocks'], path)
    if (typeof message.content !== 'string') {
      throw new AgentLedgerIntegrityError(`${path}.content must be a string`)
    }
    if (!Array.isArray(message.toolCalls)) {
      throw new AgentLedgerIntegrityError(`${path}.toolCalls must be an array`)
    }
    const parsed: DurableAgentMessage = {
      role: 'assistant',
      content: message.content,
      toolCalls: message.toolCalls.map((call, index) => {
        const callPath = `${path}.toolCalls[${index}]`
        const record = requireRecord(call, callPath)
        requireExactKeys(record, ['id', 'name', 'args'], [], callPath)
        if (typeof record.id !== 'string' || record.id.trim() === '') {
          throw new AgentLedgerIntegrityError(`${callPath}.id must be a non-empty string`)
        }
        if (typeof record.name !== 'string' || record.name.trim() === '') {
          throw new AgentLedgerIntegrityError(`${callPath}.name must be a non-empty string`)
        }
        return {
          id: record.id,
          name: record.name,
          args: cloneJsonObject(record.args, `${callPath}.args`),
        }
      }),
    }
    if (message.nativeBlocks !== undefined) {
      if (!Array.isArray(message.nativeBlocks)) {
        throw new AgentLedgerIntegrityError(`${path}.nativeBlocks must be an array when present`)
      }
      parsed.nativeBlocks = message.nativeBlocks.map((block, index) => {
        const blockPath = `${path}.nativeBlocks[${index}]`
        const cloned = cloneJsonObject(block, blockPath)
        if (cloned.type !== 'thinking' && cloned.type !== 'redacted_thinking') {
          throw new AgentLedgerIntegrityError(`${blockPath}.type is unsupported: ${String(cloned.type)}`)
        }
        return cloned as ClaudeAssistantNativeBlock
      })
    }
    return parsed
  }
  if (message.role === 'tool') {
    requireExactKeys(message, ['role', 'toolCallId', 'content'], [], path)
    if (typeof message.toolCallId !== 'string' || message.toolCallId.trim() === '') {
      throw new AgentLedgerIntegrityError(`${path}.toolCallId must be a non-empty string`)
    }
    return {
      role: 'tool',
      toolCallId: message.toolCallId,
      content: parseToolResultContent(message.content, `${path}.content`),
    }
  }
  throw new AgentLedgerIntegrityError(`${path}.role is unsupported: ${String(message.role)}`)
}

function parseToolResultContent(value: unknown, path: string): DurableToolResultContent {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new AgentLedgerIntegrityError(`${path} JSON is invalid: ${message}`)
      }
    }
    return value
  }
  if (!Array.isArray(value)) {
    throw new AgentLedgerIntegrityError(`${path} must be a string or content block array`)
  }
  return value.map((block, index): DurableToolResultContentBlock => {
    const blockPath = `${path}[${index}]`
    const record = requireRecord(block, blockPath)
    if (record.type === 'text') {
      requireExactKeys(record, ['type', 'text'], [], blockPath)
      if (typeof record.text !== 'string') {
        throw new AgentLedgerIntegrityError(`${blockPath}.text must be a string`)
      }
      return { type: 'text', text: record.text }
    }
    if (record.type === 'image_ref') {
      requireExactKeys(
        record,
        ['type', 'mediaId', 'mediaType'],
        ['width', 'height', 'description'],
        blockPath,
      )
      if (typeof record.mediaId !== 'string' || !/^[1-9]\d*$/.test(record.mediaId)) {
        throw new AgentLedgerIntegrityError(`${blockPath}.mediaId must be a positive decimal string`)
      }
      if (typeof record.mediaType !== 'string' || record.mediaType.trim() === '') {
        throw new AgentLedgerIntegrityError(`${blockPath}.mediaType must be a non-empty string`)
      }
      const output: DurableToolResultContentBlock = {
        type: 'image_ref',
        mediaId: record.mediaId,
        mediaType: record.mediaType,
      }
      if (record.width !== undefined) {
        output.width = requirePositiveSafeInteger(record.width, `${blockPath}.width`)
      }
      if (record.height !== undefined) {
        output.height = requirePositiveSafeInteger(record.height, `${blockPath}.height`)
      }
      if (record.description !== undefined) {
        if (typeof record.description !== 'string') {
          throw new AgentLedgerIntegrityError(`${blockPath}.description must be a string`)
        }
        output.description = record.description
      }
      return output
    }
    throw new AgentLedgerIntegrityError(`${blockPath}.type is unsupported: ${String(record.type)}`)
  })
}

function validateCompactionChain(
  entries: readonly AgentLedgerEntry[],
): CompactionAgentLedgerEntry | null {
  let previous: CompactionAgentLedgerEntry | null = null
  for (const entry of entries) {
    if (entry.entryType !== 'compaction') continue
    const expected = previous?.id.toString() ?? null
    if (entry.payload.previousCompactionEntryId !== expected) {
      throw new AgentLedgerIntegrityError(
        `compaction entry ${entry.id.toString()} previousCompactionEntryId must be ${expected ?? 'null'}`,
      )
    }
    previous = entry
  }
  return previous
}

function selectActiveMessages(
  entries: readonly AgentLedgerEntry[],
  latestCompaction: CompactionAgentLedgerEntry | null,
): DurableAgentMessage[] {
  if (latestCompaction == null) {
    return entries
      .filter((entry): entry is MessageAgentLedgerEntry => entry.entryType === 'message')
      .map((entry) => entry.payload.message)
  }

  const boundary = latestCompaction.payload.firstKeptEntryId == null
    ? null
    : BigInt(latestCompaction.payload.firstKeptEntryId)
  if (boundary != null) {
    const boundaryEntry = entries.find((entry) => entry.id === boundary)
    if (!boundaryEntry) {
      throw new AgentLedgerIntegrityError(
        `compaction entry ${latestCompaction.id.toString()} boundary ${boundary.toString()} does not exist`,
      )
    }
    if (boundaryEntry.entryType !== 'message') {
      throw new AgentLedgerIntegrityError(
        `compaction entry ${latestCompaction.id.toString()} boundary must reference a message entry`,
      )
    }
    if (boundaryEntry.payload.message.role === 'tool') {
      throw new AgentLedgerIntegrityError(
        `compaction entry ${latestCompaction.id.toString()} boundary cannot start on a tool result`,
      )
    }
  }

  const active: DurableAgentMessage[] = []
  for (const entry of entries) {
    if (entry.entryType !== 'message') continue
    if (entry.id > latestCompaction.id || (boundary != null && entry.id >= boundary)) {
      active.push(entry.payload.message)
    }
  }
  return active
}

function renderSummaryMessage(payload: CompactionLedgerPayload): DurableAgentMessage {
  const restState = payload.restResumeState == null
    ? ''
    : `${REST_STATE_MARKER}${JSON.stringify({
        event: 'rest_resume_state',
        emittedAt: payload.restResumeState.emittedAt,
        nonPauseActionSince: payload.restResumeState.nonPauseActionSince,
      })}`
  return { role: 'user', content: `${HISTORY_SUMMARY_PREFIX}${payload.summary}${restState}` }
}

function renderMachineStateMessages(payload: CompactionLedgerPayload): DurableAgentMessage[] {
  if (Object.keys(payload.mailboxAttentionState).length === 0) return []
  return [{ role: 'user', content: renderMailboxAttentionStateEvent(payload.mailboxAttentionState) }]
}

function assertSnapshotIntegrity(
  messages: readonly DurableAgentMessage[],
  runtimeState: AgentRuntimeState,
  label: string,
): void {
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    messages: [...messages],
    qqConversationFocus: runtimeState.qqConversationFocus,
  }
  const result = validateBotSnapshotIntegrity({
    snapshot,
    mailboxCursors: runtimeState.mailboxCursors,
    mailboxContinuity: runtimeState.mailboxContinuity,
    goalRevision: runtimeState.goalRevision,
  })
  if (!result.ok) {
    throw new AgentLedgerIntegrityError(result.errors.map((error) => `${label}: ${error}`))
  }
}

function assertStrictlyIncreasingIds(entries: readonly AgentLedgerEntry[]): void {
  for (let index = 1; index < entries.length; index++) {
    if (entries[index]!.id <= entries[index - 1]!.id) {
      throw new AgentLedgerIntegrityError(
        `entry IDs must be strictly increasing at entries[${index}]`,
      )
    }
  }
}

function parseMailboxAttentionState(value: unknown, path: string): MailboxAttentionState {
  const record = requireRecord(value, path)
  const parsed: MailboxAttentionState = {}
  for (const mailbox of Object.keys(record).sort()) {
    if (!MAILBOX_KEY_PATTERN.test(mailbox)) {
      throw new AgentLedgerIntegrityError(`${path}.${mailbox} has invalid mailbox key`)
    }
    const cursorPath = `${path}.${mailbox}`
    const cursors = requireRecord(record[mailbox], cursorPath)
    requireExactKeys(cursors, ['disclosedThroughRowId', 'handledThroughRowId'], [], cursorPath)
    parsed[mailbox] = {
      disclosedThroughRowId: requireNonNegativeSafeInteger(
        cursors.disclosedThroughRowId,
        `${cursorPath}.disclosedThroughRowId`,
      ),
      handledThroughRowId: requireNonNegativeSafeInteger(
        cursors.handledThroughRowId,
        `${cursorPath}.handledThroughRowId`,
      ),
    }
  }
  return parsed
}

function parseRestResumeState(value: unknown, path: string): RestResumeCompactionState | null {
  if (value === null) return null
  const state = requireRecord(value, path)
  requireExactKeys(state, ['emittedAt', 'nonPauseActionSince'], [], path)
  if (typeof state.emittedAt !== 'string' || !Number.isFinite(Date.parse(state.emittedAt))) {
    throw new AgentLedgerIntegrityError(`${path}.emittedAt must be a valid timestamp string`)
  }
  if (typeof state.nonPauseActionSince !== 'boolean') {
    throw new AgentLedgerIntegrityError(`${path}.nonPauseActionSince must be boolean`)
  }
  return { emittedAt: state.emittedAt, nonPauseActionSince: state.nonPauseActionSince }
}

function parseNullableEntryId(value: unknown, path: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !POSITIVE_DECIMAL_PATTERN.test(value)) {
    throw new AgentLedgerIntegrityError(`${path} must be a positive decimal string or null`)
  }
  return value
}

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentLedgerIntegrityError(`${path} must be a non-negative safe integer`)
  }
  return value as number
}

function requirePositiveSafeInteger(value: unknown, path: string): number {
  const parsed = requireNonNegativeSafeInteger(value, path)
  if (parsed === 0) throw new AgentLedgerIntegrityError(`${path} must be positive`)
  return parsed
}

function cloneJsonObject(value: unknown, path: string): Record<string, unknown> {
  const record = requireRecord(value, path)
  return cloneJsonRecord(record, path)
}

function cloneJsonRecord(value: Record<string, unknown>, path: string): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    output[key] = cloneJsonValue(value[key], `${path}.${key}`)
  }
  return output
}

function cloneJsonValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AgentLedgerIntegrityError(`${path} must contain only finite JSON numbers`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJsonValue(item, `${path}[${index}]`))
  }
  if (isRecord(value)) return cloneJsonRecord(value, path)
  throw new AgentLedgerIntegrityError(`${path} contains a non-JSON value`)
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AgentLedgerIntegrityError(`${path} must be an object`)
  }
  return value
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new AgentLedgerIntegrityError(`${path}.${key} is required`)
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new AgentLedgerIntegrityError(`${path}.${key} is not supported`)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function formatEntryId(value: bigint | null): string {
  return value == null ? 'null' : value.toString()
}
