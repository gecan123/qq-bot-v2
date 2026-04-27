import type { Opportunity, QueueKind } from './agent-runtime-types.js'

export type ArbiterChoice =
  | { kind: 'opportunity'; opportunityId: string; reason: string }
  | { kind: 'rest'; reason: string }

export interface ArbiterCandidate {
  opportunityId: string
  queueKind: QueueKind
  opportunityType: string
  priority: number
  deadlineAt?: Date | null
  createdAt?: Date | null
  reason?: string
}

export type ArbiterProposal =
  | { kind: 'opportunity'; opportunityId: string; reason?: string }
  | { kind: 'rest'; reason?: string }

const QUEUE_RANK: Record<QueueKind, number> = {
  obligation: 4,
  social: 3,
  curiosity: 2,
  maintenance: 1,
}

function compareCandidates(a: ArbiterCandidate, b: ArbiterCandidate): number {
  const queue = QUEUE_RANK[b.queueKind] - QUEUE_RANK[a.queueKind]
  if (queue !== 0) return queue
  const priority = b.priority - a.priority
  if (priority !== 0) return priority
  const aDeadline = a.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY
  const bDeadline = b.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY
  if (aDeadline !== bDeadline) return aDeadline - bDeadline
  const aCreated = a.createdAt?.getTime() ?? 0
  const bCreated = b.createdAt?.getTime() ?? 0
  return aCreated - bCreated
}

export function buildArbiterCandidates(opportunities: readonly Opportunity[]): ArbiterCandidate[] {
  return opportunities
    .filter((opportunity) => opportunity.status === 'pending')
    .map((opportunity) => ({
      opportunityId: opportunity.id,
      queueKind: opportunity.queueKind,
      opportunityType: opportunity.opportunityType,
      priority: opportunity.priority,
      deadlineAt: opportunity.deadlineAt,
      reason: `${opportunity.queueKind}:${opportunity.opportunityType}`,
    }))
    .sort(compareCandidates)
}

export function chooseDeterministicCandidate(candidates: readonly ArbiterCandidate[]): ArbiterChoice {
  const candidate = [...candidates].sort(compareCandidates)[0]
  if (!candidate) return { kind: 'rest', reason: 'no candidate opportunities' }
  return {
    kind: 'opportunity',
    opportunityId: candidate.opportunityId,
    reason: `selected existing ${candidate.queueKind} opportunity`,
  }
}

export function acceptArbiterProposal(
  candidates: readonly ArbiterCandidate[],
  proposal: ArbiterProposal,
): ArbiterChoice {
  if (proposal.kind === 'rest') {
    return { kind: 'rest', reason: proposal.reason ?? 'arbiter chose rest' }
  }

  const candidateIds = new Set(candidates.map((candidate) => candidate.opportunityId))
  if (!candidateIds.has(proposal.opportunityId)) {
    return {
      kind: 'rest',
      reason: `arbiter proposal rejected unknown opportunity: ${proposal.opportunityId}`,
    }
  }

  return {
    kind: 'opportunity',
    opportunityId: proposal.opportunityId,
    reason: proposal.reason ?? 'arbiter selected existing opportunity',
  }
}
