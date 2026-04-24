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
  throw new Error(`${name} should not be called for ambient audit-only decisions`)
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
})
