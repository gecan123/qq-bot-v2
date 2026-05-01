import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createReplyExecutor } from './reply-executor.js'
import type { ReplyOpportunity } from './reply-decision-types.js'
import type { MessageSender } from '../messaging/message-sender.js'
import type { ReplyExecutorOptions } from './reply-executor.js'

function mentionOpportunity(overrides: Partial<ReplyOpportunity> = {}): ReplyOpportunity {
  return {
    opportunityId: 'qq_group:1:message:42:mention',
    runtimeKey: 'qq_group:1',
    groupId: 1,
    sceneId: 'qq_group:1',
    scopeKey: 'qq_group:1',
    sourceKind: 'mention',
    cueStrength: 'strong',
    mustReplyOverride: true,
    replyProbability: 1,
    anchorMessageRowId: 42,
    triggerMessageRowId: 42,
    triggerMessageId: 10042,
    triggerSenderId: 20,
    incorporatedMessageRowId: 42,
    incorporatedMessageId: 10042,
    deliveryMode: 'reply_to_message',
    dryRun: false,
    reason: 'mention test opportunity',
    createdAt: new Date('2026-04-24T00:00:00Z'),
    ...overrides,
  }
}

function fail(name: string): never {
  throw new Error(`${name} should not be called`)
}

describe('reply executor', () => {
  test('sendable mention delivery is owned by action record state', async () => {
    const states: string[] = []
    let sendCalls = 0
    const sender: MessageSender = {
      isReplyDryRunEnabled: () => false,
      isSendDryRunEnabled: () => false,
      replyToMessage: async (params) => {
        sendCalls++
        assert.equal(params.groupId, 1)
        assert.equal(params.replyToMessageId, 10042)
        assert.equal(params.mentionUserId, 20)
        assert.equal(params.text, '收到')
        return { success: true, providerMessageId: 9001, attempts: 1 }
      },
      sendMessage: async () => fail('sendMessage'),
    }

    const executor = createReplyExecutor({
      decisionEngine: {
        decide(opportunity) {
          return {
            opportunity: { ...opportunity, deliveryMode: 'reply_to_message', dryRun: false },
            outcome: 'sendable_reply',
            policy: {
              shouldGenerate: true,
              shouldCreateReplyRecord: true,
              shouldDeliver: true,
              shouldAudit: false,
              reason: 'direct mention',
            },
            replyIntentId: 'mention-intent-42',
            deliveryMode: 'reply_to_message',
            dryRun: false,
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
        segments: [{ type: 'text', content: '@bot ping' }],
      }),
      generateReply: async (_message, opportunity) => {
        assert.equal(opportunity.opportunityId, 'qq_group:1:message:42:mention')
        assert.equal(opportunity.sceneId, 'qq_group:1')
        assert.equal(opportunity.triggerMessageRowId, 42)
        return '收到'
      },
      replyRecordStore: {
        findByReplyIntentId: async () => null,
        createOrReuse: async (input) => ({
          id: 1,
          runtimeKey: input.runtimeKey,
          groupId: input.groupId,
          scopeKey: input.scopeKey,
          replyIntentId: input.replyIntentId,
          sourceKind: input.sourceKind,
          triggerMessageRowId: input.triggerMessageRowId,
          incorporatedMessageRowId: input.incorporatedMessageRowId,
          deliveryPayload: input.deliveryPayload,
          text: input.text,
          executionState: input.executionState ?? 'pending',
          providerMessageId: null,
          attemptCount: 0,
          createdAt: new Date('2026-04-24T00:00:00Z'),
          updatedAt: new Date('2026-04-24T00:00:00Z'),
        }),
        markAcked: async (_id, providerMessageId) => {
          states.push(`reply:acked:${providerMessageId}`)
        },
        markSending: async () => {
          states.push('reply:sending')
        },
        markSent: async () => {
          states.push('reply:sent')
        },
        markFailed: async () => fail('markFailed'),
      },
      actionRecordStore: {
        createOrReuseIntent: async (input) => ({
          id: input.id,
          opportunityId: input.opportunityId,
          actionType: input.actionType,
          targetSceneId: input.targetSceneId,
          payload: input.payload,
          dryRun: input.dryRun,
          riskLevel: input.riskLevel ?? 'anchored_group_reply',
          status: input.status ?? 'pending',
          idempotencyKey: input.idempotencyKey,
        }),
        createOrReuseRecord: async (input) => ({
          id: input.id,
          actionIntentId: input.actionIntentId,
          actionType: input.actionType,
          targetSceneId: input.targetSceneId,
          deliveryState: input.deliveryState,
          idempotencyKey: input.idempotencyKey,
          resultPayload: input.resultPayload,
          createdAt: new Date('2026-04-24T00:00:00Z'),
          updatedAt: new Date('2026-04-24T00:00:00Z'),
        }),
        markDeliveryState: async (id, deliveryState, resultPayload) => {
          states.push(`action:${deliveryState}`)
          return {
            id,
            actionIntentId: 'mention-intent-42',
            actionType: 'send_group_reply',
            targetSceneId: 'qq_group:1',
            deliveryState,
            idempotencyKey: 'mention-intent-42',
            resultPayload: resultPayload ?? null,
            createdAt: new Date('2026-04-24T00:00:00Z'),
            updatedAt: new Date('2026-04-24T00:00:00Z'),
          }
        },
      },
      deliver: async () => fail('deliverReplyRecord'),
    })

    const result = await executor.execute(mentionOpportunity({
      sourceKind: 'mention',
      cueStrength: 'strong',
      mustReplyOverride: true,
      deliveryMode: 'reply_to_message',
      dryRun: false,
    }))

    assert.equal(result.deliveryResult, 'sent')
    assert.equal(result.actionRecord?.deliveryState, 'sent')
    assert.equal(sendCalls, 1)
    assert.deepEqual(states, [
      'action:sending',
      'reply:sending',
      'action:sent',
      'reply:acked:9001',
      'reply:sent',
    ])
  })

  test('sendable private reply creates private_reply action record and uses private sender', async () => {
    const states: string[] = []
    let privateSendCalls = 0
    const sender: MessageSender = {
      isReplyDryRunEnabled: () => false,
      isSendDryRunEnabled: () => false,
      replyToMessage: async () => fail('replyToMessage'),
      sendMessage: async () => fail('sendMessage'),
      sendPrivateMessage: async (params) => {
        privateSendCalls++
        assert.equal(params.userId, 20)
        assert.equal(params.text, '私聊收到')
        return { success: true, providerMessageId: 9002, attempts: 1 }
      },
    }

    const executor = createReplyExecutor({
      sender,
      buildIncomingMessage: async () => ({
        groupId: 20,
        sceneKind: 'qq_private',
        sceneExternalId: '20',
        sceneId: 'qq_private:20',
        messageId: 20042,
        senderId: 20,
        senderNickname: '用户20',
        segments: [{ type: 'text', content: 'ping' }],
      }),
      generateReply: async () => '私聊收到',
      replyRecordStore: {
        findByReplyIntentId: async () => null,
        createOrReuse: async (input) => ({
          id: 2,
          runtimeKey: input.runtimeKey,
          groupId: input.groupId,
          scopeKey: input.scopeKey,
          replyIntentId: input.replyIntentId,
          sourceKind: input.sourceKind,
          triggerMessageRowId: input.triggerMessageRowId,
          incorporatedMessageRowId: input.incorporatedMessageRowId,
          deliveryPayload: input.deliveryPayload,
          text: input.text,
          executionState: input.executionState ?? 'pending',
          providerMessageId: null,
          attemptCount: 0,
          createdAt: new Date('2026-04-24T00:00:00Z'),
          updatedAt: new Date('2026-04-24T00:00:00Z'),
        }),
        markAcked: async (_id, providerMessageId) => {
          states.push(`reply:acked:${providerMessageId}`)
        },
        markSending: async () => {
          states.push('reply:sending')
        },
        markSent: async () => {
          states.push('reply:sent')
        },
        markFailed: async () => fail('markFailed'),
      },
      actionRecordStore: {
        createOrReuseIntent: async (input) => {
          assert.equal(input.actionType, 'send_private_message')
          assert.equal(input.targetSceneId, 'qq_private:20')
          assert.equal(input.riskLevel, 'private_reply')
          return {
            id: input.id,
            opportunityId: input.opportunityId,
            actionType: input.actionType,
            targetSceneId: input.targetSceneId,
            payload: input.payload,
            dryRun: input.dryRun,
            riskLevel: input.riskLevel ?? 'private_reply',
            status: input.status ?? 'approved',
            idempotencyKey: input.idempotencyKey,
          }
        },
        createOrReuseRecord: async (input) => ({
          id: input.id,
          actionIntentId: input.actionIntentId,
          actionType: input.actionType,
          targetSceneId: input.targetSceneId,
          deliveryState: input.deliveryState,
          idempotencyKey: input.idempotencyKey,
          resultPayload: input.resultPayload,
          createdAt: new Date('2026-04-24T00:00:00Z'),
          updatedAt: new Date('2026-04-24T00:00:00Z'),
        }),
        markDeliveryState: async (id, deliveryState, resultPayload) => {
          states.push(`action:${deliveryState}`)
          return {
            id,
            actionIntentId: 'private-intent-42',
            actionType: 'send_private_message',
            targetSceneId: 'qq_private:20',
            deliveryState,
            idempotencyKey: 'private-intent-42',
            resultPayload: resultPayload ?? null,
            createdAt: new Date('2026-04-24T00:00:00Z'),
            updatedAt: new Date('2026-04-24T00:00:00Z'),
          }
        },
      },
    })

    const result = await executor.execute(mentionOpportunity({
      opportunityId: 'qq_private:20:message:42:private_reply',
      runtimeKey: 'agent:main',
      groupId: 20,
      targetUserId: 20,
      sceneId: 'qq_private:20',
      scopeKey: 'qq_private:20',
      sourceKind: 'private_message',
      cueStrength: 'strong',
      mustReplyOverride: true,
      replyProbability: 1,
      anchorMessageRowId: 42,
      deliveryMode: 'send_private_message',
      dryRun: false,
    }))

    assert.equal(result.deliveryResult, 'sent')
    assert.equal(privateSendCalls, 1)
    assert.deepEqual(states, [
      'action:sending',
      'reply:sending',
      'action:sent',
      'reply:acked:9002',
      'reply:sent',
    ])
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
          // 强制返回 sendable, 但 deliveryMode 跟 sourceKind 不匹配
          // (mention 应该 reply_to_message; private 应该 send_private_message)。
          // 此处用 audit_only 制造 unsupported sendable 生成路径, 守护代码应当 skip。
          return {
            opportunity: { ...opportunity, deliveryMode: 'audit_only', dryRun: false },
            outcome: 'sendable_reply',
            policy: {
              shouldGenerate: true,
              shouldCreateReplyRecord: true,
              shouldDeliver: true,
              shouldAudit: false,
              reason: 'unsupported sendable policy combination',
            },
            replyIntentId: 'unsupported-audit-only',
            deliveryMode: 'audit_only',
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

    const result = await executor.execute(mentionOpportunity({ deliveryMode: 'audit_only' }))

    assert.equal(result.deliveryResult, 'skipped')
    assert.equal(result.replyRecord, undefined)
    assert.equal(findCalls, 0)
    assert.equal(generateCalls, 0)
  })
})
