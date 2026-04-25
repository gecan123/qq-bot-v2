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
        sendMessage: async () => {
          throw new Error('sendMessage should not be called for send_group_reply')
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
      riskLevel: 'L3',
      status: 'approved',
      idempotencyKey: 'intent-1',
    } satisfies ActionIntent)

    assert.equal(result.deliveryResult, 'sent')
    assert.deepEqual(states, ['sending', 'sent'])
  })

  it('keeps dry-run send_group_message intents away from sender calls', async () => {
    const result = await createActionExecutor({
      sender: {
        replyToMessage: async () => {
          throw new Error('replyToMessage should not be called for dry-run send_group_message')
        },
        sendMessage: async () => {
          throw new Error('sendMessage should not be called for dry-run send_group_message')
        },
      },
      actionStore: {
        createOrReuseActionRecord: async (input) => ({
          id: 'record-2',
          actionIntentId: input.actionIntentId,
          actionType: input.actionType,
          targetSceneId: input.targetSceneId,
          deliveryState: input.deliveryState ?? 'pending',
          idempotencyKey: input.idempotencyKey,
          resultPayload: input.resultPayload ?? null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }),
      },
    }).execute({
      id: 'intent-2',
      opportunityId: 'opportunity-2',
      decisionId: 'decision-2',
      actionType: 'send_group_message',
      targetSceneId: 'qq_group:1',
      payload: {
        target: { groupId: 1, sceneId: 'qq_group:1' },
        proposedEffect: { type: 'send_group_message', text: 'candidate' },
      },
      dryRun: true,
      riskLevel: 'L3',
      status: 'skipped',
      idempotencyKey: 'intent-2',
    } satisfies ActionIntent)

    assert.equal(result.deliveryResult, 'dry_run')
  })
})
