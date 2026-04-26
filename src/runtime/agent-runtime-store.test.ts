import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertActionIntentPayloadSafe,
  assertSelfSpineSourceCanMutate,
  assertReferenceOnlyPayload,
  assertRuntimeSnapshotReferenceOnly,
  buildMessageReferencePayload,
  canAutoAcceptMemoryProposal,
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

  it('only auto-accepts low-risk observation memory proposals when configured', () => {
    assert.equal(
      canAutoAcceptMemoryProposal(
        { proposalType: 'observation', confidence: 0.8, salience: 0.2 },
        { enabled: true },
      ),
      true,
    )
    assert.equal(
      canAutoAcceptMemoryProposal(
        { proposalType: 'preference', confidence: 0.9, salience: 0.1 },
        { enabled: true },
      ),
      false,
    )
    assert.equal(
      canAutoAcceptMemoryProposal(
        { proposalType: 'preference', confidence: 0.9, salience: 0.1 },
        { enabled: true, allowedTypes: ['preference'] },
      ),
      false,
    )
    assert.equal(
      canAutoAcceptMemoryProposal(
        { proposalType: 'observation', confidence: 0.4, salience: 0.2 },
        { enabled: true },
      ),
      false,
    )
    assert.equal(
      canAutoAcceptMemoryProposal(
        { proposalType: 'observation', confidence: 0.9, salience: 0.7 },
        { enabled: true },
      ),
      false,
    )
  })

  it('blocks direct Self Spine mutation from a single message or forum post', () => {
    assert.throws(
      () => assertSelfSpineSourceCanMutate({ basis: 'single_message', sourceRefs: [{ messageRowId: 1 }] }),
      /single-source single_message/,
    )
    assert.throws(
      () => assertSelfSpineSourceCanMutate({ basis: 'single_forum_post', sourceRefs: [{ feedItemId: 'feed-1' }] }),
      /single-source single_forum_post/,
    )
    assert.throws(
      () => assertSelfSpineSourceCanMutate({ sourceRefs: [{ messageRowId: 1 }] }),
      /single message or single forum post/,
    )
    assert.throws(
      () => assertSelfSpineSourceCanMutate({ basis: 'aggregate_review', sourceRefs: [{ messageRowId: 1 }] }),
      /multiple distinct source refs/,
    )
    assert.throws(
      () => assertSelfSpineSourceCanMutate({ basis: 'aggregate_review', sourceRefs: [{ messageRowId: 1 }, { messageRowId: 1 }] }),
      /multiple distinct source refs/,
    )
    assert.throws(
      () => assertSelfSpineSourceCanMutate({ sourceRefs: [] }),
      /requires review basis/,
    )
    assert.doesNotThrow(() => assertSelfSpineSourceCanMutate({
      basis: 'aggregate_review',
      sourceRefs: [{ messageRowId: 1 }, { feedItemId: 'feed-1' }],
    }))
    assert.doesNotThrow(() => assertSelfSpineSourceCanMutate({
      basis: 'manual_review',
      sourceRefs: [{ messageRowId: 1 }],
    }))
  })
})
