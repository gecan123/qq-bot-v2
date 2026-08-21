import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { conversationKey } from '../chat/conversation.js'
import { isChatAttentionEvent, shouldQueueChatEvent, type ChatMessageEvent } from './event.js'

function groupEvent(mentionedSelf: boolean): ChatMessageEvent {
  return {
    type: 'chat_message',
    eventKind: 'message',
    messageRowId: 1,
    conversation: {
      platform: 'qq',
      accountId: '10000',
      kind: 'group',
      externalId: '1001',
    },
    messageExternalId: '2001',
    senderExternalId: '3001',
    senderName: '群友',
    mentionedSelf,
    sentAt: new Date('2026-07-20T00:00:00.000Z'),
    renderedText: 'hello',
  }
}

describe('isChatAttentionEvent', () => {
  test('only private messages and mentioned group messages qualify as attention', () => {
    const ordinaryGroup = groupEvent(false)
    assert.equal(isChatAttentionEvent(ordinaryGroup), false)
    assert.equal(isChatAttentionEvent(groupEvent(true)), true)
    assert.equal(isChatAttentionEvent({
      type: 'chat_message',
      eventKind: 'message',
      messageRowId: 2,
      conversation: {
        platform: 'feishu',
        accountId: 'cli_1',
        kind: 'private',
        externalId: 'oc_1',
      },
      messageExternalId: 'om_1',
      senderExternalId: 'ou_1',
      senderName: '主人',
      mentionedSelf: true,
      sentAt: new Date('2026-07-20T00:00:00.000Z'),
      renderedText: 'hello',
    }), true)

    assert.equal(shouldQueueChatEvent(ordinaryGroup, new Set()), false)
    assert.equal(shouldQueueChatEvent(
      ordinaryGroup,
      new Set([conversationKey(ordinaryGroup.conversation)]),
    ), true)
    assert.equal(isChatAttentionEvent({ ...ordinaryGroup, eventKind: 'recall' }), true)
  })
})
