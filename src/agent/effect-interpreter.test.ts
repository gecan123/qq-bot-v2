import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { interpretToolEffects } from './effect-interpreter.js'

describe('interpretToolEffects', () => {
  test('accepts trusted send and inbox effects', () => {
    assert.deepEqual(interpretToolEffects([
      {
        toolCallId: 'send-1',
        toolName: 'send_message',
        effect: { type: 'message_sent', target: { type: 'private', userId: 123 } },
      },
      {
        toolCallId: 'inbox-1',
        toolName: 'inbox',
        effect: { type: 'inbox_read', mailbox: 'qq_private:123', throughRowId: 42 },
      },
    ]), {
      sentTargets: [{ type: 'private', userId: 123 }],
      inboxReads: [{ mailbox: 'qq_private:123', throughRowId: 42 }],
    })
  })

  test('rejects effects from unrelated tools', () => {
    assert.deepEqual(interpretToolEffects([{
      toolCallId: 'lookup-1',
      toolName: 'lookup',
      effect: { type: 'message_sent', target: { type: 'group', groupId: 123 } },
    }]), { sentTargets: [] })
  })
})
