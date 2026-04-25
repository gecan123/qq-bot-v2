import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertReferenceOnlyPayload, buildMessageReferencePayload } from './agent-runtime-store.js'

describe('agent runtime store payload policy', () => {
  it('builds message-derived event payloads as reference-only', () => {
    assert.deepEqual(
      buildMessageReferencePayload({
        messageRowId: 7,
        messageId: 1007,
        ingestSource: 'onebot',
        source: 'qq_group',
        idempotencyKey: 'group_message:7',
      }),
      {
        messageRowId: 7,
        messageId: 1007,
        ingestSource: 'onebot',
        source: 'qq_group',
        idempotencyKey: 'group_message:7',
      },
    )
  })

  it('rejects copied user facts in runtime/opportunity payloads', () => {
    assert.throws(
      () => assertReferenceOnlyPayload({ messageRowId: 7, messageId: 1007, idempotencyKey: 'x', plainText: 'hello' }),
      /reference-only.*plainText/,
    )
    assert.throws(
      () => assertReferenceOnlyPayload({ messageRowId: 7, messageId: 1007, idempotencyKey: 'x', senderNickname: '用户' }),
      /reference-only.*senderNickname/,
    )
  })
})
