import type { ConversationMemoryContext, MemoryEvidenceKind } from './memory-store.js'

export interface MemoryEvidenceRow {
  rowId: number
  sceneKind: 'qq_group' | 'qq_private'
  sceneExternalId: string
  groupId: number | null
  messageId: string
  senderId: string
  sentAt: string
}

export type LoadMemorySourceEvidence = (
  sourceMessageIds: readonly number[],
) => Promise<readonly MemoryEvidenceRow[]>

export interface DerivedMemoryEvidence {
  context: ConversationMemoryContext
  assertedByIds: string[]
  evidenceKind: MemoryEvidenceKind
}

export function deriveMemoryEvidence(input: {
  rows: readonly MemoryEvidenceRow[]
  subjectId?: string
  ownerId?: string
  requestedKind?: MemoryEvidenceKind
}): DerivedMemoryEvidence {
  if (input.rows.length === 0) throw new Error('memory evidence requires at least one Message row')
  const contexts = new Map<string, ConversationMemoryContext>()
  for (const row of input.rows) {
    const context = row.sceneKind === 'qq_group'
      ? { kind: 'qq_group' as const, id: String(row.groupId) }
      : { kind: 'qq_private' as const, id: row.sceneExternalId }
    if (!context.id || context.id === 'null') throw new Error(`memory evidence row ${row.rowId} has no scene id`)
    contexts.set(`${context.kind}:${context.id}`, context)
  }
  if (contexts.size !== 1) {
    throw new Error('ordinary memory write requires evidence from exactly one conversation context')
  }
  const assertedByIds = [...new Set(input.rows.map((row) => row.senderId))]
  const derivedKind = input.subjectId && assertedByIds.every((id) => id === input.subjectId)
    ? 'self_report'
    : input.ownerId && assertedByIds.every((id) => id === input.ownerId)
      ? 'owner_assertion'
      : 'third_party_report'
  const evidenceKind = input.requestedKind ?? derivedKind
  if (evidenceKind === 'self_report' && (!input.subjectId || assertedByIds.some((id) => id !== input.subjectId))) {
    throw new Error('self_report evidence must be authored by the person subject')
  }
  if (evidenceKind === 'owner_assertion' && (!input.ownerId || assertedByIds.some((id) => id !== input.ownerId))) {
    throw new Error('owner_assertion evidence must be authored by the configured owner')
  }
  return {
    context: [...contexts.values()][0]!,
    assertedByIds,
    evidenceKind,
  }
}
