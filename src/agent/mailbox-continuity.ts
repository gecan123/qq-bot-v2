export const MAILBOX_LIGHT_COMPENSATION_AFTER_MS = 2 * 60 * 60 * 1_000
export const MAILBOX_FULL_COMPENSATION_AFTER_ROUNDS = 30
export const MAILBOX_FULL_COMPENSATION_AFTER_TOKENS = 128_000
export const MAILBOX_LIGHT_CONTEXT_BEFORE = 1
export const MAILBOX_FULL_CONTEXT_BEFORE = 8

const MAILBOX_CONTINUITY_SCHEMA_VERSION = 1
const MAILBOX_KEY_PATTERN = /^qq_(?:group|private):\d+$/

export interface MailboxContinuityAnchor {
  lastMessageAtMs: number
  roundSeq: number
  inputTokens: number | null
  compactionEpoch: number
}

export interface MailboxContinuityState {
  schemaVersion: number
  roundSeq: number
  lastInputTokens: number | null
  compactionEpoch: number
  mailboxes: Record<string, MailboxContinuityAnchor>
}

export interface MailboxCompensationDecision {
  mode: 'none' | 'light' | 'full'
  contextBefore: number
  elapsedMs: number | null
  roundsSince: number | null
  tokensSince: number | null
  compactionChanged: boolean
}

export function createEmptyMailboxContinuityState(): MailboxContinuityState {
  return {
    schemaVersion: MAILBOX_CONTINUITY_SCHEMA_VERSION,
    roundSeq: 0,
    lastInputTokens: null,
    compactionEpoch: 0,
    mailboxes: {},
  }
}

export function parseMailboxContinuityState(value: unknown): MailboxContinuityState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createEmptyMailboxContinuityState()
  }
  const obj = value as Record<string, unknown>
  const mailboxes: Record<string, MailboxContinuityAnchor> = {}
  const rawMailboxes = obj.mailboxes
  if (rawMailboxes && typeof rawMailboxes === 'object' && !Array.isArray(rawMailboxes)) {
    for (const [key, rawAnchor] of Object.entries(rawMailboxes as Record<string, unknown>)) {
      if (!MAILBOX_KEY_PATTERN.test(key)) continue
      const anchor = parseAnchor(rawAnchor)
      if (anchor) mailboxes[key] = anchor
    }
  }
  return {
    schemaVersion: MAILBOX_CONTINUITY_SCHEMA_VERSION,
    roundSeq: nonNegativeInteger(obj.roundSeq) ?? 0,
    lastInputTokens: nullableNonNegativeInteger(obj.lastInputTokens),
    compactionEpoch: nonNegativeInteger(obj.compactionEpoch) ?? 0,
    mailboxes,
  }
}

export function decideMailboxCompensation(
  state: Readonly<MailboxContinuityState>,
  mailboxKey: string,
  messageAtMs: number,
): MailboxCompensationDecision {
  const anchor = state.mailboxes[mailboxKey]
  if (!anchor) {
    return {
      mode: 'none',
      contextBefore: 0,
      elapsedMs: null,
      roundsSince: null,
      tokensSince: null,
      compactionChanged: false,
    }
  }

  const elapsedMs = Math.max(0, messageAtMs - anchor.lastMessageAtMs)
  const roundsSince = Math.max(0, state.roundSeq - anchor.roundSeq)
  const tokensSince = state.lastInputTokens == null || anchor.inputTokens == null
    ? null
    : Math.max(0, state.lastInputTokens - anchor.inputTokens)
  const compactionChanged = state.compactionEpoch !== anchor.compactionEpoch
  const full = compactionChanged
    || roundsSince >= MAILBOX_FULL_COMPENSATION_AFTER_ROUNDS
    || (tokensSince != null && tokensSince >= MAILBOX_FULL_COMPENSATION_AFTER_TOKENS)

  if (full) {
    return {
      mode: 'full',
      contextBefore: MAILBOX_FULL_CONTEXT_BEFORE,
      elapsedMs,
      roundsSince,
      tokensSince,
      compactionChanged,
    }
  }
  if (elapsedMs >= MAILBOX_LIGHT_COMPENSATION_AFTER_MS) {
    return {
      mode: 'light',
      contextBefore: MAILBOX_LIGHT_CONTEXT_BEFORE,
      elapsedMs,
      roundsSince,
      tokensSince,
      compactionChanged,
    }
  }
  return {
    mode: 'none',
    contextBefore: 0,
    elapsedMs,
    roundsSince,
    tokensSince,
    compactionChanged,
  }
}

export function recordMailboxDisclosure(
  state: MailboxContinuityState,
  mailboxKey: string,
  messageAtMs: number,
): void {
  const currentAnchor = state.mailboxes[mailboxKey]
  if (currentAnchor && messageAtMs < currentAnchor.lastMessageAtMs) return

  state.mailboxes[mailboxKey] = {
    lastMessageAtMs: messageAtMs,
    roundSeq: state.roundSeq,
    inputTokens: state.lastInputTokens,
    compactionEpoch: state.compactionEpoch,
  }
}

export function recordMailboxRound(
  state: MailboxContinuityState,
  inputTokens: number | null,
): void {
  state.roundSeq += 1
  if (inputTokens != null && Number.isSafeInteger(inputTokens) && inputTokens >= 0) {
    state.lastInputTokens = inputTokens
  }
}

export function recordMailboxCompaction(state: MailboxContinuityState): void {
  state.compactionEpoch += 1
  // Compaction changes the prompt-size baseline; the next successful LLM round
  // establishes a fresh comparable inputTokens value.
  state.lastInputTokens = null
}

function parseAnchor(value: unknown): MailboxContinuityAnchor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const lastMessageAtMs = nonNegativeInteger(obj.lastMessageAtMs)
  const roundSeq = nonNegativeInteger(obj.roundSeq)
  const compactionEpoch = nonNegativeInteger(obj.compactionEpoch)
  if (lastMessageAtMs == null || roundSeq == null || compactionEpoch == null) return null
  return {
    lastMessageAtMs,
    roundSeq,
    inputTokens: nullableNonNegativeInteger(obj.inputTokens),
    compactionEpoch,
  }
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
}

function nullableNonNegativeInteger(value: unknown): number | null {
  return value == null ? null : nonNegativeInteger(value)
}
