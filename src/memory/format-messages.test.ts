import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatMessagesForMemory } from './format-messages.js'
import type { Message } from '../generated/prisma/client.js'

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    groupId: 100n,
    groupName: '测试群',
    mediaReferenceIds: [],
    messageId: 1n,
    senderId: 1n,
    senderNickname: '小明',
    senderGroupNickname: null,
    content: [{ type: 'text', content: '你好' }] as unknown as Message['content'],
    rawContent: null,
    rawMessage: null,
    searchText: '',
    resolvedText: null,
    sentAt: null,
    createdAt: new Date('2026-01-01T10:30:00'),
    ...overrides,
  } as Message
}

describe('formatMessagesForMemory', () => {
  test('formats a text message with time and nickname', () => {
    const result = formatMessagesForMemory([makeMsg()])
    assert.ok(result.includes('小明'))
    assert.ok(result.includes('你好'))
    assert.ok(result.includes('10:30'))
  })

  test('prefers sentAt over createdAt for display time', () => {
    const result = formatMessagesForMemory([
      makeMsg({
        sentAt: new Date('2026-01-01T08:15:00'),
        createdAt: new Date('2026-01-01T10:30:00'),
      }),
    ])

    assert.ok(result.includes('08:15'))
    assert.ok(!result.includes('10:30'))
  })

  test('prefers senderGroupNickname over senderNickname', () => {
    const result = formatMessagesForMemory([makeMsg({ senderGroupNickname: '群昵称' })])
    assert.ok(result.includes('群昵称'))
    assert.ok(!result.includes('小明'))
  })

  test('skips messages with no renderable text', () => {
    const result = formatMessagesForMemory([
      makeMsg({ content: [{ type: 'reply', messageId: '123' }] as unknown as Message['content'] }),
    ])
    assert.equal(result.trim(), '')
  })

  test('returns empty string for empty array', () => {
    assert.equal(formatMessagesForMemory([]), '')
  })
})
