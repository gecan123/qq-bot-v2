import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { renderBotEvent } from './render-event.js'

describe('renderBotEvent', () => {
  test('renders napcat_message with sender + mention tag', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: '在吗 [图片: 一只猫]',
    })
    assert.equal(out, '[张三(QQ:100) [@bot]] 在吗 [图片: 一只猫]')
  })

  test('omits mention tag when mentionedSelf is false', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 2,
      groupId: 999,
      messageId: 12346,
      senderId: 200,
      senderNickname: '李四',
      mentionedSelf: false,
      sentAt: new Date(),
      renderedText: '吃了吗',
    })
    assert.equal(out, '[李四(QQ:200)] 吃了吗')
  })

  test('returns null for wake events (not appended to context)', () => {
    assert.equal(renderBotEvent({ type: 'wake' }), null)
  })

  test('byte-stable: same input produces same output across calls', () => {
    const event = {
      type: 'napcat_message' as const,
      messageRowId: 5,
      groupId: 999,
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
})
