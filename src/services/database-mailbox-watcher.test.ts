import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Message } from '../generated/prisma/client.js'
import { messageRowToChatEvent } from './database-mailbox-watcher.js'

function messageRow(overrides: Partial<Message> = {}): Message {
  return {
    rowId: 7,
    eventKind: 'message',
    eventExternalId: 'message:42',
    platform: 'qq',
    accountId: '10000',
    conversationKind: 'group',
    conversationExternalId: '20000',
    conversationName: '测试群',
    mediaReferenceIds: [],
    messageExternalId: '42',
    replyToExternalId: null,
    rootExternalId: null,
    threadExternalId: null,
    senderExternalId: '30000',
    senderName: 'Alice',
    senderConversationName: '群名片',
    content: [{ type: 'at', targetId: '10000' }],
    rawContent: null,
    rawMessage: null,
    searchText: '@bot hello',
    resolvedText: '@bot hello',
    sentAt: new Date('2026-08-21T00:00:00Z'),
    createdAt: new Date('2026-08-21T00:00:01Z'),
    ...overrides,
  }
}

describe('database mailbox message mapping', () => {
  test('maps message lifecycle rows into platform-neutral Agent events', () => {
    assert.deepEqual(messageRowToChatEvent(messageRow(), '@bot hello', '10000'), {
      type: 'chat_message',
      eventKind: 'message',
      messageRowId: 7,
      conversation: {
        platform: 'qq',
        accountId: '10000',
        kind: 'group',
        externalId: '20000',
      },
      conversationName: '测试群',
      messageExternalId: '42',
      senderExternalId: '30000',
      senderName: '群名片',
      mentionedSelf: true,
      sentAt: new Date('2026-08-21T00:00:00Z'),
      renderedText: '@bot hello',
    })

    assert.equal(messageRowToChatEvent(messageRow({
      rowId: 8,
      eventKind: 'recall',
      eventExternalId: 'recall:42',
      content: [],
      searchText: '',
      resolvedText: '',
    }), '', '10000').renderedText, '[消息已撤回: 42]')
  })
})
