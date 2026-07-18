export interface MemorySourceEvidenceQuery {
  sourceMessageIds: readonly number[]
  scope?: 'person' | 'group'
  id?: string
}

export type ValidateMemorySourceEvidence = (
  query: MemorySourceEvidenceQuery,
) => Promise<readonly number[]>
