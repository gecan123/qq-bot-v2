import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentMessage } from './agent-context.types.js'
import {
  captureMailboxAttentionState,
  findPendingMailboxThroughRowId,
  isMailboxAttentionStateMessage,
  renderMailboxAttentionStateEvent,
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

  test('captures and merges raw and compacted mailbox attention cursors', () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: '{"event":"mailbox_attention_state","mailboxes":{"qq_private:9001":{"disclosedThroughRowId":80,"handledThroughRowId":70},"qq_group:99":{"disclosedThroughRowId":55,"handledThroughRowId":55}}}',
      },
      {
        role: 'user',
        content: '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
      },
      {
        role: 'user',
        content: '{"event":"mailbox_handled","mailbox":"qq_private:9001","throughRowId":75}',
      },
      {
        role: 'user',
        content: '{"event":"mailbox_handled","mailbox":"qq_private:9002","throughRowId":12}',
      },
    ]

    assert.deepEqual(captureMailboxAttentionState(messages), {
      'qq_group:99': { disclosedThroughRowId: 55, handledThroughRowId: 55 },
      'qq_private:9001': { disclosedThroughRowId: 88, handledThroughRowId: 75 },
      'qq_private:9002': { disclosedThroughRowId: 0, handledThroughRowId: 12 },
    })
  })

  test('renders sorted byte-stable state and recognizes only valid controlled messages', () => {
    const content = renderMailboxAttentionStateEvent({
      'qq_private:9002': { disclosedThroughRowId: 12, handledThroughRowId: 4 },
      'qq_group:99': { disclosedThroughRowId: 55, handledThroughRowId: 55 },
    })

    assert.equal(
      content,
      '{"event":"mailbox_attention_state","mailboxes":{"qq_group:99":{"disclosedThroughRowId":55,"handledThroughRowId":55},"qq_private:9002":{"disclosedThroughRowId":12,"handledThroughRowId":4}}}',
    )
    assert.equal(isMailboxAttentionStateMessage({ role: 'user', content }), true)
    assert.equal(isMailboxAttentionStateMessage({
      role: 'assistant',
      content,
      toolCalls: [],
    }), false)
    assert.equal(isMailboxAttentionStateMessage({
      role: 'user',
      content: '{"event":"mailbox_attention_state","mailboxes":{"qq_private:9002":{"disclosedThroughRowId":12,"handledThroughRowId":-1}}}',
    }), false)
  })

  test('finds pending cursors from compacted state and ignores unsafe state cursors', () => {
    const pending: AgentMessage[] = [{
      role: 'user',
      content: '{"event":"mailbox_attention_state","mailboxes":{"qq_private:9001":{"disclosedThroughRowId":88,"handledThroughRowId":0}}}',
    }]
    assert.equal(findPendingMailboxThroughRowId(pending, 'qq_private:9001'), 88)

    const handled: AgentMessage[] = [
      ...pending,
      {
        role: 'user',
        content: '{"event":"mailbox_attention_state","mailboxes":{"qq_private:9001":{"disclosedThroughRowId":88,"handledThroughRowId":88}}}',
      },
      {
        role: 'user',
        content: '{"event":"mailbox_attention_state","mailboxes":{"qq_private:9001":{"disclosedThroughRowId":9007199254740992,"handledThroughRowId":0}}}',
      },
    ]
    assert.equal(findPendingMailboxThroughRowId(handled, 'qq_private:9001'), null)
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
