import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentMessage } from './agent-context.types.js'
import {
  findPendingMailboxThroughRowId,
  renderMailboxHandledEvent,
} from './mailbox-handled.js'

describe('mailbox handled cursor', () => {
  test('finds the latest disclosed cursor that is newer than the handled cursor', () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":10}',
      },
      {
        role: 'user',
        content: '{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":8}',
      },
    ]

    assert.equal(findPendingMailboxThroughRowId(messages, 'qq_private:123'), 10)
  })

  test('returns null when the latest disclosed range is already handled', () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":10}',
      },
      {
        role: 'user',
        content: '{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":10}',
      },
    ]

    assert.equal(findPendingMailboxThroughRowId(messages, 'qq_private:123'), null)
  })

  test('ignores malformed JSON, non-user messages, and other mailboxes', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: '{not-json' },
      {
        role: 'assistant',
        content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":99}',
        toolCalls: [],
      },
      {
        role: 'user',
        content: '{"event":"inbox_update","mailbox":"qq_group:123","throughRowId":88}',
      },
      {
        role: 'user',
        content: '{"event":"other","mailbox":"qq_private:123","throughRowId":77}',
      },
      {
        role: 'user',
        content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":12}',
      },
    ]

    assert.equal(findPendingMailboxThroughRowId(messages, 'qq_private:123'), 12)
  })

  test('uses the greatest safe positive cursor for each event kind', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":20}' },
      { role: 'user', content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":0}' },
      { role: 'user', content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":12.5}' },
      { role: 'user', content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":9007199254740992}' },
      { role: 'user', content: '{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":15}' },
      { role: 'user', content: '{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":9}' },
      { role: 'user', content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":18}' },
    ]

    assert.equal(findPendingMailboxThroughRowId(messages, 'qq_private:123'), 20)

    const greatestHandledWins: AgentMessage[] = [
      { role: 'user', content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":12}' },
      { role: 'user', content: '{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":15}' },
      { role: 'user', content: '{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":9}' },
    ]
    assert.equal(findPendingMailboxThroughRowId(greatestHandledWins, 'qq_private:123'), null)
  })

  test('renders a byte-stable handled event', () => {
    assert.equal(
      renderMailboxHandledEvent('qq_private:123', 10),
      '{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":10}',
    )
  })

  test('rejects invalid mailbox keys and cursors', () => {
    assert.throws(
      () => findPendingMailboxThroughRowId([], 'bad-key'),
      /invalid mailbox key/,
    )
    assert.throws(
      () => renderMailboxHandledEvent('qq_private:123', 0),
      /positive safe integer/,
    )
    assert.throws(
      () => renderMailboxHandledEvent('qq-private:123', 10),
      /invalid mailbox key/,
    )
  })
})
