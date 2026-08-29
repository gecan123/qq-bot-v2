import type { AgentMessage } from './agent-context.types.js'
import { isMailboxKey } from './mailbox.js'

export interface MailboxAttentionCursorState {
  disclosedThroughRowId: number
  handledThroughRowId: number
  highPriorityThroughRowId?: number
}

export type MailboxAttentionState = Record<string, MailboxAttentionCursorState>

export interface PendingInboxReadDefaults {
  afterRowId: number
  contextBefore?: number
}

export function captureMailboxAttentionState(
  messages: readonly AgentMessage[],
): MailboxAttentionState {
  const merged = new Map<string, MailboxAttentionCursorState>()

  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue
    const payload = parseJsonObject(message.content)
    if (!payload) continue

    const compactedState = parseMailboxAttentionStatePayload(payload)
    if (compactedState) {
      for (const [mailbox, cursors] of Object.entries(compactedState)) {
        mergeMailboxCursors(merged, mailbox, cursors)
      }
      continue
    }

    const disclosure = parseMailboxDisclosure(payload)
    if (disclosure) {
      mergeMailboxCursors(merged, disclosure.mailbox, {
        disclosedThroughRowId: disclosure.throughRowId,
        handledThroughRowId: 0,
        ...(disclosure.highPriority && !isPrivateMailbox(disclosure.mailbox)
          ? { highPriorityThroughRowId: disclosure.throughRowId }
          : {}),
      })
      continue
    }
    if (
      payload.event === 'mailbox_handled'
      && isMailboxKey(payload.mailbox)
      && isPositiveSafeInteger(payload.throughRowId)
    ) {
      mergeMailboxCursors(merged, payload.mailbox, {
        disclosedThroughRowId: 0,
        handledThroughRowId: payload.throughRowId,
      })
    }
  }

  const state: MailboxAttentionState = {}
  for (const mailbox of [...merged.keys()].sort()) {
    state[mailbox] = { ...merged.get(mailbox)! }
  }
  return state
}

function parseMailboxDisclosure(
  payload: Record<string, unknown>,
): { mailbox: string; throughRowId: number; highPriority: boolean } | null {
  if (
    payload.event === 'inbox_update'
    && isMailboxKey(payload.mailbox)
    && isPositiveSafeInteger(payload.throughRowId)
  ) {
    return {
      mailbox: payload.mailbox,
      throughRowId: payload.throughRowId,
      highPriority: isPrivateMailbox(payload.mailbox),
    }
  }
  if (
    payload.event !== 'notification'
    || payload.kind !== 'inbox_update'
    || !isRecord(payload.data)
    || !isMailboxKey(payload.data.mailbox)
    || !isPositiveSafeInteger(payload.data.throughRowId)
  ) {
    return null
  }
  return {
    mailbox: payload.data.mailbox,
    throughRowId: payload.data.throughRowId,
    highPriority: payload.priority === 'high' && payload.delivery === 'interrupt',
  }
}

export function findPendingMailboxThroughRowId(
  messages: readonly AgentMessage[],
  mailbox: string,
): number | null {
  assertMailboxKey(mailbox)
  const cursors = captureMailboxAttentionState(messages)[mailbox]
  if (!cursors) return null
  return cursors.disclosedThroughRowId > cursors.handledThroughRowId
    ? cursors.disclosedThroughRowId
    : null
}

export function hasPendingMailboxAttention(
  messages: readonly AgentMessage[],
  inboxReadCursors: Readonly<Record<string, number>> = {},
): boolean {
  return Object.entries(captureMailboxAttentionState(messages)).some(([mailbox, cursors]) => (
    Math.max(
      isPrivateMailbox(mailbox)
        ? cursors.disclosedThroughRowId
        : cursors.highPriorityThroughRowId ?? 0,
      0,
    ) > Math.max(cursors.handledThroughRowId, inboxReadCursors[mailbox] ?? 0)
  ))
}

export function findPendingHighPriorityInboxReadDefaults(
  messages: readonly AgentMessage[],
  mailbox: string,
  inboxReadCursor = 0,
): PendingInboxReadDefaults | null {
  assertMailboxKey(mailbox)
  const handledThroughRowId = captureMailboxAttentionState(messages)[mailbox]?.handledThroughRowId ?? 0
  const consumedThroughRowId = Math.max(inboxReadCursor, handledThroughRowId)

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user' || typeof message.content !== 'string') continue
    const payload = parseJsonObject(message.content)
    if (
      !payload
      || payload.event !== 'notification'
      || payload.kind !== 'inbox_update'
      || payload.priority !== 'high'
      || payload.delivery !== 'interrupt'
      || !isRecord(payload.data)
      || payload.data.mailbox !== mailbox
      || !isPositiveSafeInteger(payload.data.throughRowId)
      || payload.data.throughRowId <= consumedThroughRowId
      || !isRecord(payload.open)
      || payload.open.tool !== 'inbox'
      || !isRecord(payload.open.args)
      || payload.open.args.action !== 'read'
      || !isNonNegativeSafeInteger(payload.open.args.afterRowId)
    ) continue

    const contextBefore = payload.open.args.contextBefore
    return {
      afterRowId: Math.max(payload.open.args.afterRowId, consumedThroughRowId),
      ...(isPositiveSafeInteger(contextBefore) ? { contextBefore } : {}),
    }
  }

  return null
}

export function renderMailboxHandledEvent(mailbox: string, throughRowId: number): string {
  assertMailboxKey(mailbox)
  if (!isPositiveSafeInteger(throughRowId)) {
    throw new RangeError('throughRowId must be a positive safe integer')
  }

  return JSON.stringify({ event: 'mailbox_handled', mailbox, throughRowId })
}

export function renderMailboxAttentionStateEvent(state: MailboxAttentionState): string {
  const mailboxes: MailboxAttentionState = {}
  for (const mailbox of Object.keys(state).sort()) {
    assertMailboxKey(mailbox)
    const cursors = state[mailbox]
    if (
      !cursors
      || !isNonNegativeSafeInteger(cursors.disclosedThroughRowId)
      || !isNonNegativeSafeInteger(cursors.handledThroughRowId)
    ) {
      throw new RangeError(`mailbox attention cursors must be non-negative safe integers: ${mailbox}`)
    }
    mailboxes[mailbox] = {
      disclosedThroughRowId: cursors.disclosedThroughRowId,
      handledThroughRowId: cursors.handledThroughRowId,
      ...((cursors.highPriorityThroughRowId ?? 0) > 0
        ? { highPriorityThroughRowId: cursors.highPriorityThroughRowId }
        : {}),
    }
  }
  return JSON.stringify({ event: 'mailbox_attention_state', mailboxes })
}

export function isMailboxAttentionStateMessage(message: AgentMessage): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string') return false
  const payload = parseJsonObject(message.content)
  return payload != null && parseMailboxAttentionStatePayload(payload) != null
}

function parseMailboxAttentionStatePayload(
  payload: Record<string, unknown>,
): MailboxAttentionState | null {
  if (
    payload.event !== 'mailbox_attention_state'
    || !hasExactKeys(payload, ['event', 'mailboxes'])
    || !isRecord(payload.mailboxes)
  ) {
    return null
  }

  const state: MailboxAttentionState = {}
  for (const mailbox of Object.keys(payload.mailboxes).sort()) {
    const cursors = payload.mailboxes[mailbox]
    if (
      !isMailboxKey(mailbox)
      || !isRecord(cursors)
      || !hasExactKeys(cursors, ['disclosedThroughRowId', 'handledThroughRowId'], ['highPriorityThroughRowId'])
      || !isNonNegativeSafeInteger(cursors.disclosedThroughRowId)
      || !isNonNegativeSafeInteger(cursors.handledThroughRowId)
      || (cursors.highPriorityThroughRowId !== undefined
        && !isNonNegativeSafeInteger(cursors.highPriorityThroughRowId))
    ) {
      return null
    }
    state[mailbox] = {
      disclosedThroughRowId: cursors.disclosedThroughRowId,
      handledThroughRowId: cursors.handledThroughRowId,
      ...(isPositiveSafeInteger(cursors.highPriorityThroughRowId)
        ? { highPriorityThroughRowId: cursors.highPriorityThroughRowId }
        : {}),
    }
  }
  return state
}

function mergeMailboxCursors(
  merged: Map<string, MailboxAttentionCursorState>,
  mailbox: string,
  incoming: MailboxAttentionCursorState,
): void {
  const current = merged.get(mailbox)
  if (
    !current
    && incoming.disclosedThroughRowId === 0
    && incoming.handledThroughRowId === 0
    && (incoming.highPriorityThroughRowId ?? 0) === 0
  ) {
    return
  }
  const highPriorityThroughRowId = Math.max(
    current?.highPriorityThroughRowId ?? 0,
    incoming.highPriorityThroughRowId ?? 0,
  )
  merged.set(mailbox, {
    disclosedThroughRowId: Math.max(
      current?.disclosedThroughRowId ?? 0,
      incoming.disclosedThroughRowId,
    ),
    handledThroughRowId: Math.max(
      current?.handledThroughRowId ?? 0,
      incoming.handledThroughRowId,
    ),
    ...(highPriorityThroughRowId > 0 ? { highPriorityThroughRowId } : {}),
  })
}

function isPrivateMailbox(mailbox: string): boolean {
  return mailbox.startsWith('qq_private:') || mailbox.includes(':private:')
}

function assertMailboxKey(mailbox: string): void {
  if (!isMailboxKey(mailbox)) {
    throw new TypeError(`invalid mailbox key: ${mailbox}`)
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  optional: string[] = [],
): boolean {
  const keys = Object.keys(value)
  return expected.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => expected.includes(key) || optional.includes(key))
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const payload: unknown = JSON.parse(content)
    return isRecord(payload) ? payload : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
