import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createReplyDecisionEngine } from './reply-decision-engine.js'
import type { ReplyOpportunity } from './reply-decision-types.js'

function opportunity(overrides: Partial<ReplyOpportunity> = {}): ReplyOpportunity {
  return {
    opportunityId: 'qq_group:1:message:10:mention',
    runtimeKey: 'qq_group:1',
    groupId: 1,
    sceneId: 'qq_group:1',
    scopeKey: 'qq_group:1',
    sourceKind: 'mention',
    cueStrength: 'strong',
    mustReplyOverride: true,
    replyProbability: 1,
    anchorMessageRowId: 10,
    triggerMessageRowId: 10,
    triggerMessageId: 10010,
    triggerSenderId: 20,
    incorporatedMessageRowId: 10,
    incorporatedMessageId: 10010,
    deliveryMode: 'reply_to_message',
    dryRun: false,
    reason: 'test',
    createdAt: new Date(0),
    ...overrides,
  }
}

describe('reply decision engine (Phase 1.5 简化版)', () => {
  test('mention 强锚点机会变成 sendable_reply 决策', () => {
    const decision = createReplyDecisionEngine().decide(opportunity())

    assert.equal(decision.outcome, 'sendable_reply')
    assert.equal(decision.policy.shouldGenerate, true)
    assert.equal(decision.policy.shouldCreateReplyRecord, true)
    assert.equal(decision.policy.shouldDeliver, true)
    assert.equal(decision.replyIntentId, 'qq_group:1:message:10:reply_to_message')
  })

  test('private message 变成 sendable_reply with send_private_message', () => {
    const decision = createReplyDecisionEngine().decide(opportunity({
      opportunityId: 'qq_private:20:message:10:private_reply',
      runtimeKey: 'qq_private:20',
      groupId: 20,
      targetUserId: 20,
      sceneId: 'qq_private:20',
      scopeKey: 'qq_private:20',
      sourceKind: 'private_message',
      anchorMessageRowId: 10,
      deliveryMode: 'send_private_message',
      reason: 'private message',
    }))

    assert.equal(decision.outcome, 'sendable_reply')
    assert.equal(decision.deliveryMode, 'send_private_message')
    assert.equal(decision.replyIntentId, 'qq_private:20:message:10:send_private_message')
  })

  test('dry run mention 仍是 sendable, 但 audit kind = dry_run_intent', () => {
    const decision = createReplyDecisionEngine().decide(opportunity({ dryRun: true }))

    assert.equal(decision.outcome, 'sendable_reply')
    assert.equal(decision.policy.shouldGenerate, true)
    assert.equal(decision.policy.shouldAudit, true)
    assert.equal(decision.policy.auditKind, 'dry_run_intent')
    assert.equal(decision.dryRun, true)
  })

  test('非 mention 非 private 的 opportunity 进 no_intent (proactive 链路已砍)', () => {
    const decision = createReplyDecisionEngine().decide(opportunity({
      sourceKind: 'mention',
      mustReplyOverride: false,
      replyProbability: 0.5,
      anchorMessageRowId: undefined,
      deliveryMode: 'audit_only',
      dryRun: true,
    }))

    assert.equal(decision.outcome, 'no_intent')
    assert.equal(decision.policy.shouldGenerate, false)
    assert.equal(decision.policy.shouldCreateReplyRecord, false)
    assert.equal(decision.policy.shouldDeliver, false)
    assert.equal(decision.policy.shouldAudit, false)
  })
})
