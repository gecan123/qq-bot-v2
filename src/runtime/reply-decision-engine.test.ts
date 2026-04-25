import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createReplyDecisionEngine } from './reply-decision-engine.js'
import type { ReplyOpportunity } from './reply-decision-types.js'

function opportunity(overrides: Partial<ReplyOpportunity> = {}): ReplyOpportunity {
  return {
    opportunityId: 'qq_group:1:message:10:ambient',
    runtimeKey: 'qq_group:1',
    groupId: 1,
    sceneId: 'qq_group:1',
    scopeKey: 'qq_group:1',
    sourceKind: 'ambient_message',
    cueStrength: 'weak',
    mustReplyOverride: false,
    replyProbability: 0.02,
    triggerMessageRowId: 10,
    triggerMessageId: 10010,
    triggerSenderId: 20,
    incorporatedMessageRowId: 10,
    incorporatedMessageId: 10010,
    deliveryMode: 'audit_only',
    dryRun: true,
    reason: 'test',
    createdAt: new Date(0),
    ...overrides,
  }
}

describe('reply decision engine', () => {
  test('turns mention into sendable anchored reply decision', () => {
    const decision = createReplyDecisionEngine().decide(opportunity({
      opportunityId: 'qq_group:1:message:10:mention',
      sourceKind: 'mention',
      cueStrength: 'strong',
      mustReplyOverride: true,
      anchorMessageRowId: 10,
      deliveryMode: 'reply_to_message',
      dryRun: false,
    }))

    assert.equal(decision.outcome, 'sendable_reply')
    assert.equal(decision.policy.shouldGenerate, true)
    assert.equal(decision.policy.shouldCreateReplyRecord, true)
    assert.equal(decision.policy.shouldDeliver, true)
    assert.equal(decision.replyIntentId, 'qq_group:1:message:10:reply_to_message')
  })

  test('uses strong anchored opportunity semantics instead of source-specific mention branch', () => {
    const decision = createReplyDecisionEngine().decide(opportunity({
      sourceKind: 'ambient_message',
      cueStrength: 'strong',
      mustReplyOverride: true,
      replyProbability: 1,
      anchorMessageRowId: 10,
      deliveryMode: 'reply_to_message',
      dryRun: false,
    }))

    assert.equal(decision.outcome, 'sendable_reply')
    assert.equal(decision.replyIntentId, 'qq_group:1:message:10:reply_to_message')
    assert.equal(decision.deliveryMode, 'reply_to_message')
  })

  test('turns ambient message into audit-only decision without generation or sendable record', () => {
    const decision = createReplyDecisionEngine().decide(opportunity())

    assert.equal(decision.outcome, 'opportunity_detected')
    assert.equal(decision.deliveryMode, 'audit_only')
    assert.equal(decision.dryRun, true)
    assert.equal(decision.policy.shouldGenerate, false)
    assert.equal(decision.policy.shouldCreateReplyRecord, false)
    assert.equal(decision.policy.shouldDeliver, false)
    assert.equal(decision.policy.shouldAudit, true)
  })
})
