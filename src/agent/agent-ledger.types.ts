import type {
  DurableAgentMessage,
  PersistedAgentSnapshot,
  QqConversationFocus,
} from './agent-context.types.js'
import type { MailboxAttentionState } from './mailbox-handled.js'
import type { MailboxContinuityState } from './mailbox-continuity.js'
import type { MailboxCursors } from './mailbox.js'
import type { InboxReadCursors } from './inbox-read-cursors.js'

export const AGENT_LEDGER_SCHEMA_VERSION = 1 as const
export const AGENT_RUNTIME_STATE_SCHEMA_VERSION = 4 as const

export type CompactionReason = 'threshold' | 'overflow'

export interface MessageLedgerPayload {
  schemaVersion: typeof AGENT_LEDGER_SCHEMA_VERSION
  message: DurableAgentMessage
}

export interface CompactionLedgerPayload {
  schemaVersion: typeof AGENT_LEDGER_SCHEMA_VERSION
  summary: string
  firstKeptEntryId: string | null
  tokensBefore: number
  estimatedTokensAfter: number
  reason: CompactionReason
  isSplitTurn: boolean
  previousCompactionEntryId: string | null
  mailboxAttentionState: MailboxAttentionState
}

export interface MessageAgentLedgerEntry {
  id: bigint
  entryType: 'message'
  payload: MessageLedgerPayload
  createdAt: Date
}

export interface CompactionAgentLedgerEntry {
  id: bigint
  entryType: 'compaction'
  payload: CompactionLedgerPayload
  createdAt: Date
}

export type AgentLedgerEntry = MessageAgentLedgerEntry | CompactionAgentLedgerEntry

export interface AgentRuntimeState {
  schemaVersion: typeof AGENT_RUNTIME_STATE_SCHEMA_VERSION
  mailboxCursors: MailboxCursors
  inboxReadCursors: InboxReadCursors
  mailboxContinuity: MailboxContinuityState
  goalRevision: number
  qqConversationFocus: QqConversationFocus
  lastWakeAt: Date | null
  ledgerHeadEntryId: bigint | null
}

export interface AgentLedgerProjection {
  throughEntryId: bigint | null
  activeEntryCount: number
  permanentEntryCount: number
  snapshot: PersistedAgentSnapshot
}
