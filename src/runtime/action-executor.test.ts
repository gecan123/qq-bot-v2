import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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
})
