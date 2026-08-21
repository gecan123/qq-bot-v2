import type { MemoryEvidenceKind } from './memory-store.js'
import type { ChatPlatform, ConversationKind, ConversationRef, ParticipantRef } from '../chat/conversation.js'
import { conversationKey, participantKey } from '../chat/conversation.js'

export interface MemoryEvidenceRow {
  rowId: number
  platform: ChatPlatform
  accountId: string
  conversationKind: ConversationKind
  conversationExternalId: string
  messageExternalId: string
  senderExternalId: string
  sentAt: string
}

export type LoadMemorySourceEvidence = (
  sourceMessageRowIds: readonly number[],
) => Promise<readonly MemoryEvidenceRow[]>

export type DerivedMemoryContext =
  | { kind: 'conversation'; conversation: ConversationRef }
  | { kind: 'owner_core' }

export interface DerivedMemoryEvidence {
  context: DerivedMemoryContext
  assertedByIds: string[]
  evidenceKind: MemoryEvidenceKind
}

export function deriveMemoryEvidence(input: {
  rows: readonly MemoryEvidenceRow[]
  subjectKey?: string
  subjectId?: string
  ownerId?: string
  ownerIdentities?: readonly ParticipantRef[]
  requestedKind?: MemoryEvidenceKind
}): DerivedMemoryEvidence {
  if (input.rows.length === 0) throw new Error('memory evidence requires at least one Message row')
  const contexts = new Map<string, ConversationRef>()
  for (const row of input.rows) {
    const context: ConversationRef = {
      platform: row.platform,
      accountId: row.accountId,
      kind: row.conversationKind,
      externalId: row.conversationExternalId,
    }
    if (!context.accountId || !context.externalId) {
      throw new Error(`memory evidence row ${row.rowId} has no conversation identity`)
    }
    contexts.set(conversationKey(context), context)
  }
  const ownerIdentityKeys = new Set((input.ownerIdentities ?? []).map(participantKey))
  const ownerKey = ownerIdentityKeys.size > 0 ? 'owner' : input.ownerId
  const assertedByIds = [...new Set(input.rows.map((row) => {
    const key = participantKey({
      platform: row.platform,
      accountId: row.accountId,
      externalId: row.senderExternalId,
    })
    return ownerIdentityKeys.has(key) ? 'owner' : key
  }))]
  const subjectKey = input.subjectKey ?? input.subjectId
  const ownerCore = subjectKey === 'owner' && assertedByIds.every((id) => id === 'owner')
  if (!ownerCore && contexts.size !== 1) {
    throw new Error('ordinary memory write requires evidence from exactly one conversation context')
  }
  const derivedKind = subjectKey && assertedByIds.every((id) => id === subjectKey)
    ? 'self_report'
    : ownerKey && assertedByIds.every((id) => id === ownerKey)
      ? 'owner_assertion'
      : 'third_party_report'
  const evidenceKind = input.requestedKind ?? derivedKind
  if (evidenceKind === 'self_report' && (!subjectKey || assertedByIds.some((id) => id !== subjectKey))) {
    throw new Error('self_report evidence must be authored by the person subject')
  }
  if (evidenceKind === 'owner_assertion' && (!ownerKey || assertedByIds.some((id) => id !== ownerKey))) {
    throw new Error('owner_assertion evidence must be authored by the configured owner')
  }
  return {
    context: ownerCore
      ? { kind: 'owner_core' }
      : { kind: 'conversation', conversation: [...contexts.values()][0]! },
    assertedByIds,
    evidenceKind,
  }
}
