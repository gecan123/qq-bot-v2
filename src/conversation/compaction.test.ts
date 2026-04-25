import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Message } from '../generated/prisma/client.js'
import { compactConversationIfNeeded } from './compaction.js'

function makeMessage(id: number, overrides: Partial<Message> = {}): Message {
  return {
    id,
    groupId: BigInt(1),
    groupName: '测试群',
    mediaReferenceIds: [],
    messageId: BigInt(1000 + id),
    senderId: BigInt(200 + id),
    senderNickname: `用户${id}`,
    senderGroupNickname: null,
    content: [{ type: 'text', content: `原始文本${id}` }] as Message['content'],
    rawContent: null,
    rawMessage: null,
    searchText: `原始文本${id}`,
    resolvedText: `原始文本${id}`,
    sentAt: new Date(`2026-04-21T00:${String(id % 60).padStart(2, '0')}:00Z`),
    createdAt: new Date(`2026-04-21T00:${String(id % 60).padStart(2, '0')}:00Z`),
    ...overrides,
  }
}

describe('conversation compaction', () => {
  test('compaction freezes unresolved text before writing compacted base', async () => {
    const frozenWrites: Array<{ id: number; text: string }> = []
    const resolveCalls: number[] = []
    const savedStates: Array<{ compactedBase: string; lastCompactedMessageRowId: number }> = []

    const messages = Array.from({ length: 41 }, (_, index) => {
      const id = index + 1
      if (id === 1) {
        return makeMessage(id, {
          mediaReferenceIds: ['77'],
          content: [{ type: 'video', referenceId: '77' }] as Message['content'],
          resolvedText: null,
          searchText: '[视频]',
        })
      }

      if (id === 2) {
        return makeMessage(id, {
          resolvedText: '已冻结文本',
          searchText: '已冻结文本',
        })
      }

      return makeMessage(id)
    })

    await compactConversationIfNeeded(1, 'sender:20', {
      getConversationState: async () => ({
        id: 1,
        groupId: 1,
        senderThreadKey: 'sender:20',
        compactedBase: '',
        compactedVersion: 1,
        lastCompactedMessageRowId: undefined,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      getMessagesAfterRowId: async () => messages,
      getActionRecordsForScene: async () => [],
      resolveConversationMessage: async (message) => {
        resolveCalls.push(message.id)
        if (message.id === 1) {
          return [{ type: 'text', content: '解析后的媒体文本' }]
        }
        return message.content as any
      },
      freezeResolvedText: async (id, text) => {
        frozenWrites.push({ id, text })
      },
      saveCompactedState: async (params) => {
        savedStates.push({
          compactedBase: params.compactedBase,
          lastCompactedMessageRowId: params.lastCompactedMessageRowId,
        })
      },
    })

    assert.deepEqual(resolveCalls, [1])
    assert.deepEqual(frozenWrites, [{ id: 1, text: '解析后的媒体文本' }])
    assert.equal(savedStates.length, 1)
    assert.equal(savedStates[0]?.lastCompactedMessageRowId, 29)
    assert.match(savedStates[0]?.compactedBase ?? '', /解析后的媒体文本/)
    assert.match(savedStates[0]?.compactedBase ?? '', /已冻结文本/)
    assert.doesNotMatch(savedStates[0]?.compactedBase ?? '', /\[视频\]/)
  })

  test('compaction merges sent action_records as bot turns', async () => {
    const savedStates: Array<{ compactedBase: string; lastCompactedMessageRowId: number }> = []
    const messages = Array.from({ length: 41 }, (_, index) => makeMessage(index + 1))

    await compactConversationIfNeeded(1, 'sender:20', {
      getConversationState: async () => ({
        id: 1,
        groupId: 1,
        senderThreadKey: 'sender:20',
        compactedBase: '',
        compactedVersion: 1,
        lastCompactedMessageRowId: undefined,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      getMessagesAfterRowId: async () => messages,
      getActionRecordsForScene: async (sceneId) => {
        assert.equal(sceneId, 'qq_group:1')
        return [{
          id: 'action-1',
          actionIntentId: 'intent-1',
          actionType: 'send_group_reply',
          targetSceneId: 'qq_group:1',
          deliveryState: 'sent',
          idempotencyKey: 'intent-1',
          resultPayload: {
            incorporatedMessageRowId: 2,
            text: '机器人回复',
          },
          createdAt: new Date('2026-04-21T00:02:30Z'),
          updatedAt: new Date('2026-04-21T00:02:30Z'),
        }]
      },
      saveCompactedState: async (params) => {
        savedStates.push({
          compactedBase: params.compactedBase,
          lastCompactedMessageRowId: params.lastCompactedMessageRowId,
        })
      },
    })

    assert.equal(savedStates.length, 1)
    assert.match(savedStates[0]?.compactedBase ?? '', /BOT: 机器人回复/)
  })
})
