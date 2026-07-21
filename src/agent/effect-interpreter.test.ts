import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { interpretToolEffects } from './effect-interpreter.js'

describe('interpretToolEffects', () => {
  test('marks a naturally elapsed pause as a completed rest', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'pause-1',
      toolName: 'pause',
      effect: { type: 'pause', status: 'elapsed' },
    }]), {
      didPause: true,
      didCompleteRest: true,
      sentTargets: [],
    })
  })

  test('keeps interrupted and legacy pause effects from requesting a resume reminder', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'pause-1',
      toolName: 'pause',
      effect: { type: 'pause', status: 'interrupted' },
    }]), {
      didPause: true,
      didCompleteRest: false,
      sentTargets: [],
    })
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'pause-2',
      toolName: 'pause',
      effect: { type: 'pause' },
    }]), {
      didPause: true,
      didCompleteRest: false,
      sentTargets: [],
    })
  })

  test('rejects elapsed pause effects from unrelated tools', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'lookup-1',
      toolName: 'lookup',
      effect: { type: 'pause', status: 'elapsed' },
    }]), {
      didPause: false,
      didCompleteRest: false,
      sentTargets: [],
    })
  })

  test('accepts valid private and group targets only from send_message', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'send-1',
      toolName: 'send_message',
      effect: { type: 'message_sent', target: { type: 'private', userId: 123 } },
    }, {
      toolCallId: 'send-2',
      toolName: 'send_message',
      effect: { type: 'message_sent', target: { type: 'group', groupId: 456 } },
    }]), {
      didPause: false,
      didCompleteRest: false,
      sentTargets: [
        { type: 'private', userId: 123 },
        { type: 'group', groupId: 456 },
      ],
    })
  })

  test('accepts a one-round continuation only from a valid send_message effect', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'send-1',
      toolName: 'send_message',
      effect: {
        type: 'message_sent',
        target: { type: 'private', userId: 123 },
        continueWork: true,
      },
    }, {
      toolCallId: 'lookup-1',
      toolName: 'lookup',
      effect: {
        type: 'message_sent',
        target: { type: 'private', userId: 456 },
        continueWork: true,
      },
    }]), {
      didPause: false,
      didCompleteRest: false,
      sentTargets: [{ type: 'private', userId: 123 }],
      workContinuationRequested: true,
    })
  })

  test('deduplicates repeated targets while preserving first-seen order', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'send-1',
      toolName: 'send_message',
      effect: { type: 'message_sent', target: { type: 'group', groupId: 456 } },
    }, {
      toolCallId: 'send-2',
      toolName: 'send_message',
      effect: { type: 'message_sent', target: { type: 'private', userId: 123 } },
    }, {
      toolCallId: 'send-3',
      toolName: 'send_message',
      effect: { type: 'message_sent', target: { type: 'group', groupId: 456 } },
    }]), {
      didPause: false,
      didCompleteRest: false,
      sentTargets: [
        { type: 'group', groupId: 456 },
        { type: 'private', userId: 123 },
      ],
    })
  })

  test('rejects message_sent effects forged by unrelated tools', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'lookup-1',
      toolName: 'lookup',
      effect: { type: 'message_sent', target: { type: 'private', userId: 123 } },
    }]), {
      didPause: false,
      didCompleteRest: false,
      sentTargets: [],
    })
  })

  test('rejects malformed targets and non-positive or unsafe ids', () => {
    const effects = [
      { toolCallId: 'send-1', toolName: 'send_message', effect: { type: 'message_sent', target: null } },
      { toolCallId: 'send-2', toolName: 'send_message', effect: { type: 'message_sent', target: { type: 'private', userId: 0 } } },
      { toolCallId: 'send-3', toolName: 'send_message', effect: { type: 'message_sent', target: { type: 'group', groupId: Number.MAX_SAFE_INTEGER + 1 } } },
      { toolCallId: 'send-4', toolName: 'send_message', effect: { type: 'message_sent', target: { type: 'channel', channelId: 456 } } },
    ]

    assert.deepEqual(interpretToolEffects(effects as never), {
      didPause: false,
      didCompleteRest: false,
      sentTargets: [],
    })
  })

  test('accepts and coalesces inbox read cursors only from inbox', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'inbox-1',
      toolName: 'inbox',
      effect: { type: 'inbox_read', mailbox: 'qq_group:123', throughRowId: 10 },
    }, {
      toolCallId: 'inbox-2',
      toolName: 'inbox',
      effect: { type: 'inbox_read', mailbox: 'qq_group:123', throughRowId: 12 },
    }, {
      toolCallId: 'forged-1',
      toolName: 'lookup',
      effect: { type: 'inbox_read', mailbox: 'qq_private:456', throughRowId: 20 },
    }]), {
      didPause: false,
      didCompleteRest: false,
      sentTargets: [],
      inboxReads: [{ mailbox: 'qq_group:123', throughRowId: 12 }],
    })
  })
})
