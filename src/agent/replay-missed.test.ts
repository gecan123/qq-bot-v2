import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from '../database/client.js'
import type { Message } from '../generated/prisma/client.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { createDedupEnqueue } from './dedup-enqueue.js'
import { replayMissedMessages } from './replay-missed.js'

function makeGroupRow(input: {
  id: number
  groupId: number
  messageId: number
  senderId: number
  text: string
  createdAt: Date
  groupName?: string
}): Message {
  return {
    id: input.id,
    sceneKind: 'qq_group',
    sceneExternalId: '',
    groupId: BigInt(input.groupId),
    groupName: input.groupName ?? null,
    mediaReferenceIds: [],
    messageId: BigInt(input.messageId),
    senderId: BigInt(input.senderId),
    senderNickname: 'sender',
    senderGroupNickname: null,
    content: [{ type: 'text', content: input.text }] as never,
    rawContent: null,
    rawMessage: null,
    searchText: input.text,
    resolvedText: input.text,
    sentAt: null,
    createdAt: input.createdAt,
  }
}

function makePrivateRow(input: {
  id: number
  peerId: number
  messageId: number
  senderId: number
  text: string
  createdAt: Date
}): Message {
  return {
    id: input.id,
    sceneKind: 'qq_private',
    sceneExternalId: String(input.peerId),
    groupId: null,
    groupName: null,
    mediaReferenceIds: [],
    messageId: BigInt(input.messageId),
    senderId: BigInt(input.senderId),
    senderNickname: 'p',
    senderGroupNickname: null,
    content: [{ type: 'text', content: input.text }] as never,
    rawContent: null,
    rawMessage: null,
    searchText: input.text,
    resolvedText: input.text,
    sentAt: null,
    createdAt: input.createdAt,
  }
}

const stubEnsureReady = async (message: Message) => ({
  renderedText: message.resolvedText ?? '',
  fromFrozen: true,
})

describe('replayMissedMessages — multi-source × live event dedup', () => {
  let originalFindMany: typeof prisma.message.findMany | undefined

  afterEach(() => {
    if (originalFindMany) {
      ;(prisma.message as unknown as { findMany: typeof originalFindMany }).findMany = originalFindMany
      originalFindMany = undefined
    }
  })

  test('returns 0 when lastWakeAt is null (cold start avoids drowning bot in history)', async () => {
    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)
    const result = await replayMissedMessages({ mailboxCursors: {}, legacyLastWakeAt: null }, {
      enqueueMessageEvent: enq,
      selfNumber: 999,
      ensureReady: stubEnsureReady,
    })
    assert.deepEqual(result, { enqueued: 0, skippedDuplicates: 0 })
    assert.equal(q.size(), 0)
  })

  test('replay × live overlap: rows already enqueued by live path are skipped, not double-counted', async () => {
    const lastWake = new Date('2026-05-04T01:00:00Z')
    const rows: Message[] = [
      makeGroupRow({
        id: 100,
        groupId: 672312932,
        messageId: 1,
        senderId: 555,
        text: 'live arrived first',
        createdAt: new Date('2026-05-04T01:00:01Z'),
      }),
      makeGroupRow({
        id: 101,
        groupId: 672312932,
        messageId: 2,
        senderId: 555,
        text: 'only in replay',
        createdAt: new Date('2026-05-04T01:00:02Z'),
      }),
      makeGroupRow({
        id: 102,
        groupId: 672312932,
        messageId: 3,
        senderId: 555,
        text: 'also live first',
        createdAt: new Date('2026-05-04T01:00:03Z'),
      }),
    ]
    originalFindMany = prisma.message.findMany
    ;(prisma.message as unknown as { findMany: (args: unknown) => Promise<Message[]> }).findMany = (async () =>
      rows) as never

    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)

    // Simulate live path having ingested rows 100 and 102 into the queue first.
    enq({
      type: 'napcat_message',
      messageRowId: 100,
      groupId: 672312932,
      messageId: 1,
      senderId: 555,
      senderNickname: 'live',
      mentionedSelf: false,
      sentAt: new Date(),
      renderedText: 'live arrived first',
    })
    enq({
      type: 'napcat_message',
      messageRowId: 102,
      groupId: 672312932,
      messageId: 3,
      senderId: 555,
      senderNickname: 'live',
      mentionedSelf: false,
      sentAt: new Date(),
      renderedText: 'also live first',
    })
    assert.equal(q.size(), 2, 'pre-replay state')

    const result = await replayMissedMessages({ mailboxCursors: {}, legacyLastWakeAt: lastWake }, {
      enqueueMessageEvent: enq,
      selfNumber: 999,
      ensureReady: stubEnsureReady,
    })

    // Only row 101 should be added by replay; rows 100 and 102 should be deduped.
    assert.equal(result.enqueued, 1, 'replay should add only the row not seen by live')
    assert.equal(result.skippedDuplicates, 2, 'replay should report 2 duplicates skipped')
    assert.equal(q.size(), 3, 'queue total after replay = 2 live + 1 new from replay')

    // Verify all 3 distinct rowIds are present (live + replay merged correctly)
    const events: BotEvent[] = []
    while (q.size() > 0) {
      const ev = q.dequeue()
      if (ev) events.push(ev)
    }
    const rowIds = events
      .filter((e): e is Extract<BotEvent, { type: 'napcat_message' }> => e.type === 'napcat_message')
      .map((e) => e.messageRowId)
      .sort((a, b) => a - b)
    assert.deepEqual(rowIds, [100, 101, 102])
  })

  test('replay enqueues both group and private events from mixed-source DB rows', async () => {
    const lastWake = new Date('2026-05-04T00:00:00Z')
    const rows: Message[] = [
      makeGroupRow({
        id: 1,
        groupId: 672312932,
        messageId: 1,
        senderId: 555,
        text: 'group msg',
        createdAt: new Date('2026-05-04T00:01:00Z'),
      }),
      makePrivateRow({
        id: 2,
        peerId: 10001,
        messageId: 200,
        senderId: 10001,
        text: 'private msg',
        createdAt: new Date('2026-05-04T00:02:00Z'),
      }),
    ]
    originalFindMany = prisma.message.findMany
    ;(prisma.message as unknown as { findMany: (args: unknown) => Promise<Message[]> }).findMany = (async () =>
      rows) as never

    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)
    const result = await replayMissedMessages({ mailboxCursors: {}, legacyLastWakeAt: lastWake }, {
      enqueueMessageEvent: enq,
      selfNumber: 999,
      ensureReady: stubEnsureReady,
    })

    assert.equal(result.enqueued, 2)
    const types: string[] = []
    while (q.size() > 0) {
      const ev = q.dequeue()
      if (ev) types.push(ev.type)
    }
    assert.deepEqual(types.sort(), ['napcat_message', 'napcat_private_message'])
  })

  test('filters each source by its own message-row cursor', async () => {
    const rows: Message[] = [
      makeGroupRow({
        id: 10,
        groupId: 672312932,
        messageId: 1,
        senderId: 555,
        text: 'already disclosed group',
        createdAt: new Date('2026-05-04T01:00:01Z'),
      }),
      makePrivateRow({
        id: 11,
        peerId: 10001,
        messageId: 2,
        senderId: 10001,
        text: 'new private',
        createdAt: new Date('2026-05-04T01:00:02Z'),
      }),
      makeGroupRow({
        id: 12,
        groupId: 672312932,
        messageId: 3,
        senderId: 555,
        text: 'new group',
        createdAt: new Date('2026-05-04T01:00:03Z'),
      }),
      makePrivateRow({
        id: 13,
        peerId: 20002,
        messageId: 4,
        senderId: 20002,
        text: 'unknown old source',
        createdAt: new Date('2026-05-03T23:00:00Z'),
      }),
    ]
    originalFindMany = prisma.message.findMany
    ;(prisma.message as unknown as { findMany: (args: unknown) => Promise<Message[]> }).findMany = (async () =>
      rows) as never

    const q = new InMemoryEventQueue<BotEvent>()
    const result = await replayMissedMessages({
      mailboxCursors: {
        'qq_group:672312932': 10,
        'qq_private:10001': 9,
      },
      legacyLastWakeAt: new Date('2026-05-04T00:00:00Z'),
    }, {
      enqueueMessageEvent: createDedupEnqueue(q),
      selfNumber: 999,
      ensureReady: stubEnsureReady,
    })

    assert.deepEqual(result, { enqueued: 2, skippedDuplicates: 0 })
    const rowIds: number[] = []
    while (q.size() > 0) {
      const event = q.dequeue()
      if (event && 'messageRowId' in event) rowIds.push(event.messageRowId)
    }
    assert.deepEqual(rowIds, [11, 12])
  })
})
