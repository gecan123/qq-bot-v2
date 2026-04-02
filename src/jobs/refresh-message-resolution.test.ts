import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Message } from '../generated/prisma/client.js'
import { refreshResolvedTextForMedia } from './refresh-message-resolution.js'

function makeMessage(params: {
  id: number
  mediaReferenceIds: string[]
  content: unknown
  createdAt: Date
}): Message {
  return {
    id: params.id,
    groupId: BigInt(1),
    groupName: '测试群',
    mediaReferenceIds: params.mediaReferenceIds,
    messageId: BigInt(params.id),
    senderId: BigInt(200),
    senderNickname: '测试用户',
    senderGroupNickname: null,
    content: params.content as Message['content'],
    rawContent: null,
    rawMessage: null,
    searchText: '',
    resolvedText: null,
    sentAt: null,
    createdAt: params.createdAt,
  }
}

describe('refreshResolvedTextForMedia', () => {
  test('updates only messages from the configured recent window that reference the media', async () => {
    const now = new Date('2026-04-02T12:00:00.000Z')
    const candidates = [
      makeMessage({
        id: 1,
        mediaReferenceIds: ['42'],
        content: [{ type: 'image', referenceId: '42' }],
        createdAt: new Date('2026-04-02T11:45:00.000Z'),
      }),
      makeMessage({
        id: 2,
        mediaReferenceIds: ['42'],
        content: [{ type: 'image', referenceId: '42' }],
        createdAt: new Date('2026-03-31T11:00:00.000Z'),
      }),
      makeMessage({
        id: 3,
        mediaReferenceIds: ['7'],
        content: [{ type: 'image', referenceId: '7' }],
        createdAt: new Date('2026-04-02T10:00:00.000Z'),
      }),
    ]
    const updates: Array<{ id: number; resolvedText: string }> = []

    await refreshResolvedTextForMedia(42, {
      now: () => now,
      findMessages: async (mediaId, since) => {
        assert.equal(mediaId, 42)
        assert.equal(since.toISOString(), '2026-04-02T11:30:00.000Z')
        return candidates.filter((message) =>
          message.createdAt >= since && message.mediaReferenceIds.includes(String(mediaId)),
        )
      },
      resolve: async (message) => {
        return message.id === 1
          ? [{ type: 'image', referenceId: '42', summary: '一只猫' }]
          : [{ type: 'image', referenceId: '42', summary: '不应出现' }]
      },
      updateMessage: async (messageId, resolvedText) => {
        updates.push({ id: messageId, resolvedText })
      },
      windowMinutes: 30,
    })

    assert.deepEqual(updates, [{ id: 1, resolvedText: '[图片: 一只猫]' }])
  })
})
