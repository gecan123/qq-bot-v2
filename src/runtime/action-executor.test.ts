import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ActionIntent } from './agent-runtime-types.js'
import { createActionExecutor } from './action-executor.js'
import type { ActionRecord } from './action-record-store.js'

describe('action record contract', () => {
  it('models delivery/recovery independently from reply_records ids', () => {
    const record: ActionRecord = {
      id: 'intent-1:record',
      actionIntentId: 'intent-1',
      actionType: 'send_group_reply',
      targetSceneId: 'qq_group:1',
      deliveryState: 'pending',
      idempotencyKey: 'opportunity-1:send_group_reply',
      resultPayload: { deliveryPayload: { type: 'reply_to_message', replyToMessageId: 1001 }, text: 'ok' },
    }

    assert.equal(record.deliveryState, 'pending')
    assert.equal(record.targetSceneId, 'qq_group:1')
    assert.equal(Object.hasOwn(record, 'replyRecordId'), false)
  })

  it('routes send_group_reply intents to replyToMessage', async () => {
    const states: string[] = []
    const result = await createActionExecutor({
      sender: {
        replyToMessage: async (params) => {
          assert.equal(params.groupId, 1)
          assert.equal(params.replyToMessageId, 1001)
          assert.equal(params.text, 'ok')
          return { success: true, attempts: 1 }
        },
      },
      actionStore: {
        createOrReuseActionRecord: async (input) => ({
          id: 'record-1',
          actionIntentId: input.actionIntentId,
          actionType: input.actionType,
          targetSceneId: input.targetSceneId,
          deliveryState: input.deliveryState ?? 'pending',
          idempotencyKey: input.idempotencyKey,
          resultPayload: input.resultPayload ?? null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
        markDeliveryState: async (_id, state) => {
          states.push(state)
        },
      },
    }).execute({
      id: 'intent-1',
      opportunityId: 'opportunity-1',
      decisionId: 'decision-1',
      actionType: 'send_group_reply',
      targetSceneId: 'qq_group:1',
      payload: {
        target: { groupId: 1, sceneId: 'qq_group:1' },
        deliveryPayload: { type: 'reply_to_message', replyToMessageId: 1001 },
        proposedEffect: { type: 'reply_to_message', text: 'ok' },
      },
      dryRun: false,
      riskLevel: 'anchored_group_reply',
      status: 'approved',
      idempotencyKey: 'intent-1',
    } satisfies ActionIntent)

    assert.equal(result.deliveryResult, 'sent')
    assert.deepEqual(states, ['sending', 'sent'])
  })

  it('routes send_private_message intents to private sender without group send', async () => {
    const states: string[] = []
    const result = await createActionExecutor({
      sender: {
        replyToMessage: async () => {
          throw new Error('replyToMessage should not be called for send_private_message')
        },
        sendPrivateMessage: async (params) => {
          assert.equal(params.userId, 20)
          assert.equal(params.text, 'private ok')
          return { success: true, attempts: 1, providerMessageId: 9001 }
        },
      },
      actionStore: {
        createOrReuseActionRecord: async (input) => ({
          id: 'record-3',
          actionIntentId: input.actionIntentId,
          actionType: input.actionType,
          targetSceneId: input.targetSceneId,
          deliveryState: input.deliveryState ?? 'pending',
          idempotencyKey: input.idempotencyKey,
          resultPayload: input.resultPayload ?? null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
        markDeliveryState: async (_id, state) => {
          states.push(state)
        },
      },
    }).execute({
      id: 'intent-3',
      opportunityId: 'opportunity-3',
      decisionId: 'decision-3',
      actionType: 'send_private_message',
      targetSceneId: 'qq_private:20',
      payload: {
        target: { userId: 20, sceneId: 'qq_private:20' },
        proposedEffect: { type: 'send_private_message', text: 'private ok' },
      },
      dryRun: false,
      riskLevel: 'private_reply',
      status: 'approved',
      idempotencyKey: 'intent-3',
    } satisfies ActionIntent)

    assert.equal(result.deliveryResult, 'acked')
    assert.deepEqual(states, ['sending', 'acked'])
  })

  it('Phase 0: send_group_message default barrier suppresses live send', async () => {
    let replyCalled = false
    let sendGroupCalled = false
    const states: string[] = []
    const result = await createActionExecutor({
      sender: {
        replyToMessage: async () => {
          replyCalled = true
          return { success: false, attempts: 0 }
        },
        sendGroupMessage: async () => {
          sendGroupCalled = true
          return { success: false, attempts: 0 }
        },
      },
      actionStore: {
        createOrReuseActionRecord: async (input) => ({
          id: 'record-4',
          actionIntentId: input.actionIntentId,
          actionType: input.actionType,
          targetSceneId: input.targetSceneId,
          deliveryState: input.deliveryState ?? 'pending',
          idempotencyKey: input.idempotencyKey,
          resultPayload: input.resultPayload ?? null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
        markDeliveryState: async (_id, state) => {
          states.push(state)
        },
      },
    }).execute({
      id: 'intent-4',
      opportunityId: 'opportunity-4',
      decisionId: 'decision-4',
      actionType: 'send_group_message',
      targetSceneId: 'qq_group:42',
      payload: {
        target: { groupId: 42, sceneId: 'qq_group:42' },
        proposedEffect: { type: 'send_group_message', text: 'hi everyone' },
      },
      dryRun: false,
      riskLevel: 'anchored_group_reply',
      status: 'approved',
      idempotencyKey: 'intent-4',
    } satisfies ActionIntent)

    // Default barrier 把它压成 suppressed (Phase 10 之前不允许 live)。
    // ActionRecord 的初始 deliveryState 应该是 'suppressed',然后 markDeliveryState('skipped')。
    assert.equal(result.deliveryResult, 'skipped')
    assert.equal(replyCalled, false, 'replyToMessage 不应该被调用')
    assert.equal(sendGroupCalled, false, 'sendGroupMessage 也不应该被调用 (barrier 压住了)')
  })
})
