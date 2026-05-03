import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { renderBotEvent } from './render-event.js'

describe('renderBotEvent — group messages', () => {
  test('renders group message with groupName + sender + mention tag', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      groupName: '阳光厨房',
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: '在吗 [图片: 一只猫]',
    })
    assert.equal(out, '[群:阳光厨房 | 张三(QQ:100) [@bot]] 在吗 [图片: 一只猫]')
  })

  test('omits mention tag when mentionedSelf is false', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 2,
      groupId: 999,
      groupName: '阳光厨房',
      messageId: 12346,
      senderId: 200,
      senderNickname: '李四',
      mentionedSelf: false,
      sentAt: new Date(),
      renderedText: '吃了吗',
    })
    assert.equal(out, '[群:阳光厨房 | 李四(QQ:200)] 吃了吗')
  })

  test('falls back to bare group ID when groupName is missing (undefined)', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 3,
      groupId: 111111,
      messageId: 12347,
      senderId: 300,
      senderNickname: '王五',
      mentionedSelf: false,
      sentAt: new Date(),
      renderedText: 'hi',
    })
    assert.equal(out, '[群:111111 | 王五(QQ:300)] hi')
  })

  test('falls back to bare group ID when groupName is empty string', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 4,
      groupId: 222222,
      groupName: '',
      messageId: 12348,
      senderId: 400,
      senderNickname: '赵六',
      mentionedSelf: false,
      sentAt: new Date(),
      renderedText: 'yo',
    })
    assert.equal(out, '[群:222222 | 赵六(QQ:400)] yo')
  })
})

describe('renderBotEvent — private messages', () => {
  test('renders private message without [@bot] tag', () => {
    const out = renderBotEvent({
      type: 'napcat_private_message',
      messageRowId: 10,
      peerId: 10001,
      messageId: 50000,
      senderId: 10001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date(),
      renderedText: '在不',
    })
    assert.equal(out, '[私聊 | Alice(QQ:10001)] 在不')
  })

  test('private message label does NOT contain [@bot] (private is implicitly to bot)', () => {
    const out = renderBotEvent({
      type: 'napcat_private_message',
      messageRowId: 11,
      peerId: 10002,
      messageId: 50001,
      senderId: 10002,
      senderNickname: '某人',
      mentionedSelf: true,
      sentAt: new Date(),
      renderedText: '一段消息',
    })
    assert.ok(out)
    assert.equal(out!.includes('[@bot]'), false, 'private label must not contain [@bot]')
  })
})

describe('renderBotEvent — control', () => {
  test('returns null for wake events (not appended to context)', () => {
    assert.equal(renderBotEvent({ type: 'wake' }), null)
  })
})

describe('renderBotEvent — byte stability', () => {
  test('group: same input produces same output across calls', () => {
    const event = {
      type: 'napcat_message' as const,
      messageRowId: 5,
      groupId: 999,
      groupName: '阳光厨房',
      messageId: 99999,
      senderId: 300,
      senderNickname: '王五',
      mentionedSelf: false,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: '同一段文本',
    }
    const a = renderBotEvent(event)
    const b = renderBotEvent(event)
    assert.equal(a, b)
  })

  test('private: same input produces same output across calls', () => {
    const event = {
      type: 'napcat_private_message' as const,
      messageRowId: 6,
      peerId: 10001,
      messageId: 99998,
      senderId: 10001,
      senderNickname: 'Alice',
      mentionedSelf: true as const,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: '同一段文本',
    }
    const a = renderBotEvent(event)
    const b = renderBotEvent(event)
    assert.equal(a, b)
  })
})
