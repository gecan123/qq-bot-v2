import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertActionIntentPayloadSafe,
  assertReferenceOnlyPayload,
  assertRuntimeSnapshotReferenceOnly,
  buildMessageReferencePayload,
  mergeRuntimeSessionSnapshot,
} from './agent-runtime-store.js'

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

  it('rejects copied inbound facts in snapshots and action intent payloads', () => {
    assert.throws(
      () => assertRuntimeSnapshotReferenceOnly({ messages: [{ content: 'hello' }] }),
      /contextSnapshot.*content/,
    )
    assert.throws(
      () => assertActionIntentPayloadSafe({ sourceRefs: { messageRowId: 7 }, senderNickname: '用户' }),
      /actionIntent\.payload.*senderNickname/,
    )
  })

  it('allows generated outbound text only under proposedEffect', () => {
    assert.doesNotThrow(() => assertActionIntentPayloadSafe({
      sourceRefs: { messageRowId: 7, source: 'messages' },
      decisionId: 'decision-1',
      proposedEffect: { type: 'reply_to_message', text: 'generated reply' },
    }))
    assert.throws(
      () => assertActionIntentPayloadSafe({ sourceRefs: { messageRowId: 7 }, text: 'unqualified text' }),
      /actionIntent\.payload.*text/,
    )
  })

  it('merges scene cursors when updating the single agent runtime snapshot', () => {
    assert.deepEqual(
      mergeRuntimeSessionSnapshot(
        {
          focusedTargetId: 'qq_group:1',
          scenes: ['qq_group:1'],
          sceneCursors: { 'qq_group:1': 10 },
          lastObservedMessageRowId: 10,
        },
        {
          focusedTargetId: 'qq_group:2',
          scenes: ['qq_group:2'],
          sceneCursors: { 'qq_group:2': 20 },
          lastObservedMessageRowId: 20,
        },
      ),
      {
        focusedTargetId: 'qq_group:2',
        scenes: ['qq_group:1', 'qq_group:2'],
        sceneCursors: { 'qq_group:1': 10, 'qq_group:2': 20 },
        lastObservedMessageRowId: 20,
      },
    )
  })
})
