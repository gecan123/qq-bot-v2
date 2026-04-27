import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createReplyDecisionEngine } from './reply-decision-engine.js'
import type { ReplyOpportunity } from './reply-decision-types.js'
import type { ProactiveJudgeAdvice } from './proactive-judge.js'

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

function validJudgeAdvice(overrides: Partial<ProactiveJudgeAdvice> = {}): ProactiveJudgeAdvice {
  return {
    status: 'valid',
    shouldSpeak: true,
    usefulness: 0.8,
    novelty: 0.7,
    confidence: 0.9,
    interruptionCost: 0.1,
    socialRisk: 0.1,
    reason: '有明确锚点',
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

  test('turns private message into sendable private reply decision', () => {
    const decision = createReplyDecisionEngine().decide(opportunity({
      opportunityId: 'qq_private:20:message:10:private_reply',
      groupId: 20,
      targetUserId: 20,
      sceneId: 'qq_private:20',
      scopeKey: 'qq_private:20',
      sourceKind: 'private_message',
      cueStrength: 'strong',
      mustReplyOverride: true,
      replyProbability: 1,
      anchorMessageRowId: 10,
      deliveryMode: 'send_private_message',
      dryRun: false,
    }))

    assert.equal(decision.outcome, 'sendable_reply')
    assert.equal(decision.deliveryMode, 'send_private_message')
    assert.equal(decision.policy.shouldGenerate, true)
    assert.equal(decision.policy.shouldCreateReplyRecord, true)
    assert.equal(decision.policy.shouldDeliver, true)
    assert.equal(decision.replyIntentId, 'qq_private:20:message:10:send_private_message')
  })

  test('allows proactive candidate generation only with valid judge advice and dry-run policy', () => {
    const decision = createReplyDecisionEngine().decide(opportunity({
      deliveryMode: 'send_message',
      judgeAdvice: validJudgeAdvice(),
    }))

    assert.equal(decision.outcome, 'would_reply_dry_run')
    assert.equal(decision.deliveryMode, 'send_message')
    assert.equal(decision.policy.shouldGenerate, true)
    assert.equal(decision.policy.shouldCreateReplyRecord, false)
    assert.equal(decision.policy.shouldDeliver, false)
    assert.equal(decision.policy.artifactKind, 'proactive_candidate')
    assert.deepEqual(decision.policy.policyReasons, [])
  })

  test('fails closed when judge advice is missing or disabled', () => {
    const missing = createReplyDecisionEngine().decide(opportunity({ deliveryMode: 'send_message' }))
    const disabled = createReplyDecisionEngine().decide(opportunity({
      deliveryMode: 'send_message',
      judgeAdvice: {
        status: 'disabled',
        shouldSpeak: false,
        usefulness: 0,
        novelty: 0,
        confidence: 0,
        interruptionCost: 1,
        socialRisk: 1,
        reason: 'disabled',
      },
    }))

    assert.equal(missing.policy.shouldGenerate, false)
    assert.deepEqual(missing.policy.policyReasons, ['judge_missing'])
    assert.equal(disabled.policy.shouldGenerate, false)
    assert.deepEqual(disabled.policy.policyReasons, ['judge_disabled'])
  })

  test('runtime gate vetoes low-quality or risky judge advice with explicit reasons', () => {
    const decision = createReplyDecisionEngine({
      proactiveJudge: {
        minConfidence: 0.6,
        minUsefulness: 0.6,
        minNovelty: 0.4,
        maxInterruptionCost: 0.4,
        maxSocialRisk: 0.3,
      },
    }).decide(opportunity({
      deliveryMode: 'send_message',
      judgeAdvice: validJudgeAdvice({
        shouldSpeak: false,
        confidence: 0.2,
        usefulness: 0.3,
        novelty: 0.1,
        interruptionCost: 0.9,
        socialRisk: 0.8,
        suggestedDelayMs: 1000,
      }),
    }))

    assert.equal(decision.policy.shouldGenerate, false)
    assert.deepEqual(decision.policy.policyReasons, [
      'judge_veto',
      'judge_low_confidence',
      'judge_low_usefulness',
      'judge_low_novelty',
      'judge_high_interruption_cost',
      'judge_high_social_risk',
      'judge_suggested_delay_unsupported',
    ])
  })

  test('deterministic gates and zero probability cannot be promoted by judge advice', () => {
    const gated = createReplyDecisionEngine().decide(opportunity({
      deliveryMode: 'send_message',
      gateReasons: ['cooldown'],
      judgeAdvice: validJudgeAdvice(),
    }))
    const zero = createReplyDecisionEngine().decide(opportunity({
      deliveryMode: 'send_message',
      replyProbability: 0,
      judgeAdvice: validJudgeAdvice(),
    }))

    assert.equal(gated.policy.shouldGenerate, false)
    assert.deepEqual(gated.policy.policyReasons, ['cooldown'])
    assert.equal(zero.policy.shouldGenerate, false)
    assert.deepEqual(zero.policy.policyReasons, [])
  })
})
