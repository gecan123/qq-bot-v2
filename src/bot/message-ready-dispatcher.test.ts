import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Message } from '../generated/prisma/client.js'
import { createMessageReadyDispatcher } from './message-ready-dispatcher.js'

function makeMessage(id: number): Message {
  return {
    id,
    sceneKind: 'qq_group',
    sceneExternalId: '',
    groupId: BigInt(1),
    groupName: '测试群',
    mediaReferenceIds: [],
    messageId: BigInt(id),
    senderId: BigInt(200),
    senderNickname: 'sender',
    senderGroupNickname: null,
    content: [{ type: 'text', content: String(id) }] as never,
    rawContent: null,
    rawMessage: null,
    searchText: String(id),
    resolvedText: String(id),
    sentAt: null,
    createdAt: new Date(0),
  }
}

describe('createMessageReadyDispatcher', () => {
  test('schedules readiness asynchronously while preserving per-source delivery order', async () => {
    const delivered: string[] = []
    const loaded: number[] = []
    let releaseFirst!: () => void
    const firstBlocker = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const dispatcher = createMessageReadyDispatcher({
      loadMessage: async (messageRowId) => {
        loaded.push(messageRowId)
        return makeMessage(messageRowId)
      },
      ensureReady: async (message) => {
        if (message.id === 1) await firstBlocker
        return { renderedText: `ready:${message.id}`, fromFrozen: false }
      },
      onMessageReady: async (event) => {
        delivered.push(event.renderedText)
      },
    })

    dispatcher.schedule({
      kind: 'group',
      messageRowId: 1,
      groupId: 10,
      messageId: 101,
      senderId: 200,
      senderNickname: 'sender',
      mentionedSelf: false,
      sentAt: new Date(0),
    })
    dispatcher.schedule({
      kind: 'group',
      messageRowId: 2,
      groupId: 10,
      messageId: 102,
      senderId: 200,
      senderNickname: 'sender',
      mentionedSelf: false,
      sentAt: new Date(0),
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(loaded, [1])
    assert.deepEqual(delivered, [])

    releaseFirst()
    await dispatcher.drain()

    assert.deepEqual(loaded, [1, 2])
    assert.deepEqual(delivered, ['ready:1', 'ready:2'])
  })
})
