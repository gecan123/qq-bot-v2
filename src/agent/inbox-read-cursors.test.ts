import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { advanceInboxReadCursor, parseInboxReadCursors } from './inbox-read-cursors.js'

const validMailboxKeys = [
  'qq_group:123',
  'qq_private:456',
  'qq:10000:group:20000',
  'qq:10000:private:30000',
  'feishu:cli_a:group:oc_123',
  'feishu:cli_a:private:ou_123',
  'feishu:app%3Atenant:private:ou%3A123',
]

describe('inbox read cursors', () => {
  test('accepts every canonical and legacy mailbox key', () => {
    for (const mailbox of validMailboxKeys) {
      assert.deepEqual(parseInboxReadCursors({ [mailbox]: 3 }), { [mailbox]: 3 })
      assert.deepEqual(advanceInboxReadCursor({}, mailbox, 4), { [mailbox]: 4 })
    }
  })

  test('rejects malformed mailbox keys', () => {
    for (const mailbox of [
      'qq_private:not-a-number',
      'discord:app:private:user',
      'qq::private:user',
      'qq:app:channel:user',
      'feishu:app:private:',
      'feishu:app:private:user:extra',
    ]) {
      assert.throws(() => parseInboxReadCursors({ [mailbox]: 1 }), /invalid inbox mailbox key/)
      assert.throws(() => advanceInboxReadCursor({}, mailbox, 1), /invalid inbox mailbox key/)
    }
  })

  test('keeps the cursor monotonic', () => {
    assert.deepEqual(
      advanceInboxReadCursor({ 'feishu:app:private:ou_1': 9 }, 'feishu:app:private:ou_1', 4),
      { 'feishu:app:private:ou_1': 9 },
    )
  })
})
