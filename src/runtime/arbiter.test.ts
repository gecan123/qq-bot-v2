import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Opportunity } from './agent-runtime-types.js'
import {
  acceptArbiterProposal,
  buildArbiterCandidates,
  chooseDeterministicCandidate,
} from './arbiter.js'

function opportunity(input: Partial<Opportunity> & Pick<Opportunity, 'id' | 'queueKind' | 'priority'>): Opportunity {
  return {
    sceneId: 'qq_group:1',
    runtimeEventId: null,
    opportunityType: 'proactive_candidate',
    deadlineAt: null,
    payload: { source: 'messages', messageRowId: 1, messageId: 1, idempotencyKey: input.id },
    status: 'pending',
    idempotencyKey: input.id,
    ...input,
  }
}

describe('runtime arbiter', () => {
  test('builds candidate set from pending opportunities across the four queues', () => {
    const candidates = buildArbiterCandidates([
      opportunity({ id: 'social-1', queueKind: 'social', priority: 5 }),
      opportunity({ id: 'done-1', queueKind: 'obligation', priority: 100, status: 'succeeded' }),
      opportunity({ id: 'maintenance-1', queueKind: 'maintenance', priority: 20 }),
      opportunity({ id: 'curiosity-1', queueKind: 'curiosity', priority: 20 }),
    ])

    assert.deepEqual(candidates.map((candidate) => candidate.opportunityId), [
      'social-1',
      'curiosity-1',
      'maintenance-1',
    ])
  })

  test('deterministic arbiter chooses an existing candidate or rests', () => {
    const choice = chooseDeterministicCandidate([
      { opportunityId: 'social-1', queueKind: 'social', opportunityType: 'proactive_candidate', priority: 1 },
      { opportunityId: 'obligation-1', queueKind: 'obligation', opportunityType: 'reply_to_mention', priority: 1 },
    ])

    assert.deepEqual(choice, {
      kind: 'opportunity',
      opportunityId: 'obligation-1',
      reason: 'selected existing obligation opportunity',
    })
    assert.deepEqual(chooseDeterministicCandidate([]), { kind: 'rest', reason: 'no candidate opportunities' })
  })

  test('LLM proposal can only select a candidate opportunity or rest', () => {
    const candidates = [
      { opportunityId: 'known-1', queueKind: 'social' as const, opportunityType: 'proactive_candidate', priority: 1 },
    ]

    assert.deepEqual(acceptArbiterProposal(candidates, { kind: 'opportunity', opportunityId: 'known-1' }), {
      kind: 'opportunity',
      opportunityId: 'known-1',
      reason: 'arbiter selected existing opportunity',
    })
    assert.deepEqual(acceptArbiterProposal(candidates, { kind: 'rest' }), {
      kind: 'rest',
      reason: 'arbiter chose rest',
    })
    assert.deepEqual(acceptArbiterProposal(candidates, { kind: 'opportunity', opportunityId: 'invented-action' }), {
      kind: 'rest',
      reason: 'arbiter proposal rejected unknown opportunity: invented-action',
    })
  })
})
