import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Message } from '../generated/prisma/client.js'
import { createMessageReadyDispatcher } from './message-ready-dispatcher.js'

function makeMessage(id: number): Message {
  return {
    rowId: id,
    eventKind: 'message',
    eventExternalId: `message:${id}`,
    platform: 'qq',
    accountId: '10000',
    conversationKind: 'group',
    conversationExternalId: '1',
    conversationName: '测试群',
    mediaReferenceIds: [],
    messageExternalId: String(id),
    replyToExternalId: null,
    rootExternalId: null,
    threadExternalId: null,
    senderExternalId: '200',
    senderName: 'sender',
    senderConversationName: null,
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
    const delivered: Array<{ text: string; eventKind?: string }> = []
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
        if (message.rowId === 1) await firstBlocker
        return { renderedText: `ready:${message.rowId}`, fromFrozen: false }
      },
      onMessageReady: async (event) => {
        delivered.push({ text: event.renderedText, eventKind: event.eventKind })
      },
    })

    dispatcher.schedule({
      kind: 'group',
      eventKind: 'recall',
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
    assert.deepEqual(delivered, [
      { text: 'ready:1', eventKind: 'recall' },
      { text: 'ready:2', eventKind: undefined },
    ])
  })
})
