import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createReplyExecutor } from './reply-executor.js'
import type { ReplyOpportunity } from './reply-decision-types.js'
import type { MessageSender } from '../messaging/message-sender.js'
import type { ReplyExecutorOptions } from './reply-executor.js'

function ambientOpportunity(overrides: Partial<ReplyOpportunity> = {}): ReplyOpportunity {
  return {
    opportunityId: 'qq_group:1:message:42:ambient',
    runtimeKey: 'qq_group:1',
    groupId: 1,
    sceneId: 'qq_group:1',
    scopeKey: 'qq_group:1',
    sourceKind: 'ambient_message',
    cueStrength: 'weak',
    mustReplyOverride: false,
    replyProbability: 0.02,
    triggerMessageRowId: 42,
    triggerMessageId: 10042,
    triggerSenderId: 20,
    incorporatedMessageRowId: 42,
    incorporatedMessageId: 10042,
    deliveryMode: 'audit_only',
    dryRun: true,
    reason: 'ambient test opportunity',
    createdAt: new Date('2026-04-24T00:00:00Z'),
    ...overrides,
  }
}

function fail(name: string): never {
  throw new Error(`${name} should not be called`)
}

describe('reply executor', () => {
  test('ambient audit-only opportunity does not generate, create reply record, or send message', async () => {
    let generateCalls = 0
    let auditCalls = 0
    let delivered = false
    const sender: MessageSender = {
      isReplyDryRunEnabled: () => false,
      isSendDryRunEnabled: () => false,
      replyToMessage: async () => fail('replyToMessage'),
      sendMessage: async () => fail('sendMessage'),
    }
    const replyRecordStore: NonNullable<ReplyExecutorOptions['replyRecordStore']> = {
      findByReplyIntentId: async () => fail('findByReplyIntentId'),
      createOrReuse: async () => fail('createOrReuseReplyRecord'),
      markAcked: async () => fail('markAcked'),
      markSending: async () => fail('markSending'),
      markSent: async () => fail('markSent'),
      markFailed: async () => fail('markFailed'),
    }

    const executor = createReplyExecutor({
      sender,
      replyRecordStore,
      generateReply: async () => {
        generateCalls++
        return '不应该生成'
      },
      replyAuditStore: {
        create: async () => fail('createReplyAudit'),
        createOrReuse: async (input) => {
          auditCalls++
          assert.equal(input.opportunityId, 'qq_group:1:message:42:ambient')
          assert.equal(input.auditKind, 'opportunity_detected')
          assert.equal(input.replyIntentId, 'qq_group:1:message:42:ambient')
        },
      },
      deliver: async () => {
        delivered = true
        return 'sent'
      },
    })

    const result = await executor.execute(ambientOpportunity())

    assert.equal(result.deliveryResult, 'skipped')
    assert.equal(result.replyRecord, undefined)
    assert.equal(result.decision.outcome, 'opportunity_detected')
    assert.equal(generateCalls, 0)
    assert.equal(auditCalls, 1)
    assert.equal(delivered, false)
  })

  test('proactive candidate generation writes artifact and never creates reply record or sends', async () => {
    let generated = false
    let audited = false
    let storedText: string | undefined
    const judgeAdvice = {
      status: 'valid' as const,
      shouldSpeak: true,
      usefulness: 0.8,
      novelty: 0.7,
      confidence: 0.9,
      interruptionCost: 0.1,
      socialRisk: 0.1,
      reason: '有明确锚点',
    }
    const sender: MessageSender = {
      isReplyDryRunEnabled: () => false,
      isSendDryRunEnabled: () => true,
      replyToMessage: async () => fail('replyToMessage'),
      sendMessage: async () => fail('sendMessage'),
    }

    const executor = createReplyExecutor({
      decisionEngine: {
        decide(opportunity) {
          return {
            opportunity: { ...opportunity, deliveryMode: 'send_message', dryRun: true },
            outcome: 'would_reply_dry_run',
            policy: {
              shouldGenerate: true,
              shouldCreateReplyRecord: false,
              shouldDeliver: false,
              shouldAudit: true,
              artifactKind: 'proactive_candidate',
              auditKind: 'proactive_candidate',
              reason: 'test send_message dry-run producer',
              policyReasons: [],
              judgeAdvice,
            },
            replyIntentId: 'qq_group:1:message:42:send_message',
            deliveryMode: 'send_message',
            dryRun: true,
            reason: opportunity.reason,
          }
        },
      },
      sender,
      buildIncomingMessage: async () => ({
        groupId: 1,
        messageId: 10042,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '普通消息' }],
      }),
      generateReply: async () => fail('generateMentionReply'),
      generateProactiveCandidateReply: async () => {
        generated = true
        return { text: '主动候选', termination: 'final_answer' }
      },
      replyRecordStore: {
        findByReplyIntentId: async () => fail('findByReplyIntentId'),
        createOrReuse: async () => fail('createOrReuseReplyRecord'),
        markAcked: async () => fail('markAcked'),
        markSending: async () => fail('markSending'),
        markSent: async () => fail('markSent'),
        markFailed: async () => fail('markFailed'),
      },
      replyAuditStore: {
        createOrReuse: async (input) => {
          audited = true
          assert.equal(input.auditKind, 'proactive_candidate')
          assert.deepEqual((input.payload as { judgeAdvice?: unknown }).judgeAdvice, judgeAdvice)
        },
      },
      proactiveCandidateStore: {
        createOrReuse: async (artifact) => {
          storedText = artifact.candidateText
          assert.equal(artifact.status, 'candidate_generated')
          assert.deepEqual(artifact.judgeAdvice, judgeAdvice)
        },
      },
      deliver: async () => fail('deliver'),
    })

    const result = await executor.execute(ambientOpportunity({ deliveryMode: 'send_message' }))

    assert.equal(result.deliveryResult, 'skipped')
    assert.equal(result.replyRecord, undefined)
    assert.equal(generated, true)
    assert.equal(audited, true)
    assert.equal(storedText, '主动候选')
  })

  test('proactive fallback writes audit but no candidate artifact', async () => {
    let stored = false
    let auditedTermination: unknown
    const executor = createReplyExecutor({
      decisionEngine: {
        decide(opportunity) {
          return {
            opportunity: { ...opportunity, deliveryMode: 'send_message', dryRun: true },
            outcome: 'would_reply_dry_run',
            policy: {
              shouldGenerate: true,
              shouldCreateReplyRecord: false,
              shouldDeliver: false,
              shouldAudit: true,
              artifactKind: 'proactive_candidate',
              auditKind: 'proactive_candidate',
              reason: 'test implicit text disallowed',
            },
            deliveryMode: 'send_message',
            dryRun: true,
            reason: opportunity.reason,
          }
        },
      },
      buildIncomingMessage: async () => ({
        groupId: 1,
        messageId: 10042,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: '普通消息' }],
      }),
      generateReply: async () => fail('generateMentionReply'),
      generateProactiveCandidateReply: async () => ({ text: null, termination: 'implicit_text_disallowed' }),
      replyAuditStore: {
        createOrReuse: async (input) => {
          auditedTermination = (input.payload as { termination?: string }).termination
        },
      },
      proactiveCandidateStore: {
        createOrReuse: async () => {
          stored = true
        },
      },
    })

    const result = await executor.execute(ambientOpportunity({ deliveryMode: 'send_message' }))

    assert.equal(result.artifact?.status, 'no_candidate')
    assert.equal(auditedTermination, 'implicit_text_disallowed')
    assert.equal(stored, false)
  })

  test('unsupported sendable generation fails closed before creating reply record', async () => {
    let findCalls = 0
    let generateCalls = 0
    const sender: MessageSender = {
      isReplyDryRunEnabled: () => false,
      isSendDryRunEnabled: () => false,
      replyToMessage: async () => fail('replyToMessage'),
      sendMessage: async () => fail('sendMessage'),
    }

    const executor = createReplyExecutor({
      decisionEngine: {
        decide(opportunity) {
          return {
            opportunity: { ...opportunity, deliveryMode: 'send_message', dryRun: false },
            outcome: 'sendable_reply',
            policy: {
              shouldGenerate: true,
              shouldCreateReplyRecord: true,
              shouldDeliver: true,
              shouldAudit: false,
              reason: 'unsupported ambient sendable policy',
            },
            replyIntentId: 'unsupported-send-message',
            deliveryMode: 'send_message',
            dryRun: false,
            reason: opportunity.reason,
          }
        },
      },
      sender,
      buildIncomingMessage: async () => fail('buildIncomingMessage'),
      generateReply: async () => {
        generateCalls++
        return '不应该生成'
      },
      replyRecordStore: {
        findByReplyIntentId: async () => {
          findCalls++
          return null
        },
        createOrReuse: async () => fail('createOrReuseReplyRecord'),
        markAcked: async () => fail('markAcked'),
        markSending: async () => fail('markSending'),
        markSent: async () => fail('markSent'),
        markFailed: async () => fail('markFailed'),
      },
      replyAuditStore: {
        createOrReuse: async () => fail('createOrReuseReplyAudit'),
      },
      deliver: async () => fail('deliver'),
    })

    const result = await executor.execute(ambientOpportunity({ deliveryMode: 'send_message' }))

    assert.equal(result.deliveryResult, 'skipped')
    assert.equal(result.replyRecord, undefined)
    assert.equal(findCalls, 1)
    assert.equal(generateCalls, 0)
  })
})
