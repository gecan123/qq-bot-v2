import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentMessage } from './agent-context.types.js'
import {
  captureMailboxAttentionState,
  findPendingHighPriorityInboxReadDefaults,
  findPendingMailboxThroughRowId,
  hasPendingMailboxAttention,
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

  test('recognizes the unified notification envelope and keeps legacy events compatible', () => {
    const messages: AgentMessage[] = [{
      role: 'user',
      content: '{"event":"notification","id":"qq:qq_private:123:10","source":{"type":"qq","mailbox":"qq_private:123"},"kind":"inbox_update","priority":"high","delivery":"interrupt","groupKey":"qq_private:123","count":1,"open":{"tool":"inbox","args":{"action":"read"}},"data":{"mailbox":"qq_private:123","throughRowId":10}}',
    }]
    assert.equal(findPendingMailboxThroughRowId(messages, 'qq_private:123'), 10)
  })

  test('recognizes every mailbox disclosed by a compact conversation delta', () => {
    const messages: AgentMessage[] = [{
      role: 'user',
      content: '{"event":"conversation_deltas","mailboxes":[{"mailbox":"qq:bot:group:111","throughRowId":21,"priority":"normal","messages":[{"rowId":21,"text":"one"}]},{"mailbox":"qq:bot:group:222","throughRowId":32,"priority":"high","messages":[{"rowId":32,"text":"two"}]}]}',
    }]

    assert.equal(findPendingMailboxThroughRowId(messages, 'qq:bot:group:111'), 21)
    assert.equal(findPendingMailboxThroughRowId(messages, 'qq:bot:group:222'), 32)
    assert.equal(hasPendingMailboxAttention(messages, {
      'qq:bot:group:111': 21,
      'qq:bot:group:222': 31,
    }), true)
    assert.equal(hasPendingMailboxAttention(messages, {
      'qq:bot:group:111': 21,
      'qq:bot:group:222': 32,
    }), false)
  })

  test('recovers unread high-priority inbox read defaults from the latest notification', () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: '{"event":"notification","id":"qq:group:1:40","source":{"type":"qq","mailbox":"qq:10000:group:20000"},"kind":"inbox_update","priority":"normal","delivery":"passive","groupKey":"qq:10000:group:20000","count":1,"open":{"tool":"inbox","args":{"action":"read","afterRowId":39}},"data":{"mailbox":"qq:10000:group:20000","throughRowId":40}}',
      },
      {
        role: 'user',
        content: '{"event":"notification","id":"qq:group:1:51","source":{"type":"qq","mailbox":"qq:10000:group:20000"},"kind":"inbox_update","priority":"high","delivery":"interrupt","groupKey":"qq:10000:group:20000","count":8,"open":{"tool":"inbox","args":{"action":"read","afterRowId":43,"contextBefore":2}},"data":{"mailbox":"qq:10000:group:20000","throughRowId":51}}',
      },
    ]

    assert.deepEqual(
      findPendingHighPriorityInboxReadDefaults(messages, 'qq:10000:group:20000', 20),
      { afterRowId: 43, contextBefore: 2 },
    )
    assert.equal(
      findPendingHighPriorityInboxReadDefaults(messages, 'qq:10000:group:20000', 51),
      null,
    )
    assert.equal(
      findPendingHighPriorityInboxReadDefaults([
        ...messages,
        {
          role: 'user',
          content: '{"event":"mailbox_handled","mailbox":"qq:10000:group:20000","throughRowId":51}',
        },
      ], 'qq:10000:group:20000', 20),
      null,
    )
    assert.equal(
      findPendingHighPriorityInboxReadDefaults(messages, 'qq:10000:group:other', 0),
      null,
    )
  })

  test('keeps unread high-priority group mentions and private disclosures actionable', () => {
    const groupMailbox = 'qq:3999414673:group:476109921'
    const pending: AgentMessage[] = [
      {
        role: 'user',
        content: `{"event":"notification","kind":"inbox_update","priority":"high","delivery":"interrupt","open":{"tool":"inbox","args":{"action":"read","afterRowId":7803}},"data":{"mailbox":"${groupMailbox}","throughRowId":7821}}`,
      },
      {
        role: 'user',
        content: '{"event":"inbox_update","mailbox":"qq_private:123","throughRowId":10}',
      },
      {
        role: 'user',
        content: '{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":8}',
      },
    ]
    assert.equal(hasPendingMailboxAttention(pending, {
      [groupMailbox]: 7809,
      'qq_private:123': 10,
    }), true)
    assert.deepEqual(
      findPendingHighPriorityInboxReadDefaults(pending, groupMailbox, 7809),
      { afterRowId: 7809 },
    )
    assert.equal(hasPendingMailboxAttention(pending, {
      [groupMailbox]: 7821,
      'qq_private:123': 10,
    }), false)
    assert.equal(hasPendingMailboxAttention([{
      role: 'user',
      content: `{"event":"mailbox_attention_state","mailboxes":{"${groupMailbox}":{"disclosedThroughRowId":7821,"handledThroughRowId":0,"highPriorityThroughRowId":7821}}}`,
    }], { [groupMailbox]: 7809 }), true)

    const normalGroup: AgentMessage[] = [{
      role: 'user',
      content: '{"event":"notification","kind":"inbox_update","priority":"normal","delivery":"passive","open":{"tool":"inbox","args":{"action":"read","afterRowId":19}},"data":{"mailbox":"qq_group:99","throughRowId":20}}',
    }]
    assert.equal(hasPendingMailboxAttention(normalGroup), false)

    const handled = [
      ...pending,
      {
        role: 'user' as const,
        content: '{"event":"mailbox_handled","mailbox":"qq_private:123","throughRowId":10}',
      },
    ]
    assert.equal(hasPendingMailboxAttention(handled, { [groupMailbox]: 7821 }), false)
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
        content: '{"event":"mailbox_attention_state","mailboxes":{"qq_private:9001":{"disclosedThroughRowId":80,"handledThroughRowId":70},"qq_group:99":{"disclosedThroughRowId":55,"handledThroughRowId":55,"highPriorityThroughRowId":55}}}',
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
      'qq_group:99': {
        disclosedThroughRowId: 55,
        handledThroughRowId: 55,
        highPriorityThroughRowId: 55,
      },
      'qq_private:9001': { disclosedThroughRowId: 88, handledThroughRowId: 75 },
      'qq_private:9002': { disclosedThroughRowId: 0, handledThroughRowId: 12 },
    })
  })

  test('renders sorted byte-stable state and recognizes only valid controlled messages', () => {
    const content = renderMailboxAttentionStateEvent({
      'qq_private:9002': { disclosedThroughRowId: 12, handledThroughRowId: 4 },
      'qq_group:99': {
        disclosedThroughRowId: 55,
        handledThroughRowId: 55,
        highPriorityThroughRowId: 55,
      },
    })

    assert.equal(
      content,
      '{"event":"mailbox_attention_state","mailboxes":{"qq_group:99":{"disclosedThroughRowId":55,"handledThroughRowId":55,"highPriorityThroughRowId":55},"qq_private:9002":{"disclosedThroughRowId":12,"handledThroughRowId":4}}}',
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
