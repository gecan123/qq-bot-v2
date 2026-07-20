import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isChatAttentionEvent, type ChatMessageEvent } from './event.js'

function groupEvent(mentionedSelf: boolean): ChatMessageEvent {
  return {
    type: 'napcat_message',
    messageRowId: 1,
    groupId: 1001,
    messageId: 2001,
    senderId: 3001,
    senderNickname: '群友',
    mentionedSelf,
    sentAt: new Date('2026-07-20T00:00:00.000Z'),
    renderedText: 'hello',
  }
}

describe('isChatAttentionEvent', () => {
  test('only private messages and mentioned group messages qualify as attention', () => {
    assert.equal(isChatAttentionEvent(groupEvent(false)), false)
    assert.equal(isChatAttentionEvent(groupEvent(true)), true)
    assert.equal(isChatAttentionEvent({
      type: 'napcat_private_message',
      messageRowId: 2,
      peerId: 3001,
      messageId: 2002,
      senderId: 3001,
      senderNickname: '好友',
      mentionedSelf: true,
      sentAt: new Date('2026-07-20T00:00:00.000Z'),
      renderedText: 'hello',
    }), true)
  })
})
