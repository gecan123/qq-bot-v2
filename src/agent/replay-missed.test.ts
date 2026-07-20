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
  mentionedSelf?: boolean
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
    content: [
      ...(input.mentionedSelf ? [{ type: 'at', targetId: '999' }] : []),
      { type: 'text', content: input.text },
    ] as never,
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

let originalFindMany: typeof prisma.message.findMany | undefined
let originalCount: typeof prisma.message.count | undefined
let originalFindFirst: typeof prisma.message.findFirst | undefined

interface FindManyStubArgs {
  where?: Record<string, unknown>
  take?: number
  distinct?: string[]
  select?: Record<string, boolean>
}

interface FindFirstStubArgs {
  orderBy?: { id?: 'asc' | 'desc' }
  skip?: number
}

function messageMatchesWhere(message: Message, args: { where?: Record<string, unknown> }): boolean {
  const where = args.where ?? {}
  const filters = Array.isArray(where.OR) ? where.OR as Array<Record<string, unknown>> : [where]
  return filters.some((filter) => matchesFlatWhere(message, filter, where))
}

function matchesFlatWhere(
  message: Message,
  filter: Record<string, unknown>,
  root: Record<string, unknown>,
): boolean {
  if (!matchesSender(message, root.senderId)) return false
  if (filter.sceneKind !== undefined && message.sceneKind !== filter.sceneKind) return false
  if (filter.groupId !== undefined && message.groupId !== filter.groupId) return false
  if (filter.sceneExternalId !== undefined && message.sceneExternalId !== filter.sceneExternalId) return false
  if (filter.content && typeof filter.content === 'object' && 'array_contains' in filter.content) {
    const expected = (filter.content as { array_contains: Array<Record<string, unknown>> }).array_contains
    const actual = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : []
    const containsAll = expected.every((expectedSegment) => actual.some((segment) => (
      Object.entries(expectedSegment).every(([key, value]) => segment[key] === value)
    )))
    if (!containsAll) return false
  }
  if (filter.id && typeof filter.id === 'object' && 'gt' in filter.id) {
    if (message.id <= Number((filter.id as { gt: number }).gt)) return false
  }
  if (filter.createdAt && typeof filter.createdAt === 'object' && 'gt' in filter.createdAt) {
    if (message.createdAt <= (filter.createdAt as { gt: Date }).gt) return false
  }
  return true
}

function matchesSender(message: Message, filter: unknown): boolean {
  if (!filter || typeof filter !== 'object' || !('not' in filter)) return true
  return message.senderId !== (filter as { not: bigint }).not
}

function installFindManyRows(rows: Message[]): FindManyStubArgs[] {
  const calls: FindManyStubArgs[] = []
  originalFindMany = prisma.message.findMany
  ;(prisma.message as unknown as { findMany: (args: FindManyStubArgs) => Promise<unknown[]> }).findMany = (async (args: FindManyStubArgs) => {
    calls.push(structuredClone(args))
    let matched = rows.filter((row) => messageMatchesWhere(row, args)).sort((a, b) => a.id - b.id)
    if (args.distinct?.includes('sceneExternalId')) {
      const seen = new Set<string>()
      matched = matched.filter((row) => {
        if (seen.has(row.sceneExternalId)) return false
        seen.add(row.sceneExternalId)
        return true
      })
    }
    const limited = typeof args.take === 'number' ? matched.slice(0, args.take) : matched
    if (args.select) {
      return limited.map((row) => Object.fromEntries(
        Object.keys(args.select ?? {}).map((key) => [key, row[key as keyof Message]]),
      ))
    }
    return limited
  }) as never
  return calls
}

describe('replayMissedMessages — multi-source × live event dedup', () => {
  afterEach(() => {
    if (originalFindMany) {
      ;(prisma.message as unknown as { findMany: typeof originalFindMany }).findMany = originalFindMany
      originalFindMany = undefined
    }
    if (originalCount) {
      ;(prisma.message as unknown as { count: typeof originalCount }).count = originalCount
      originalCount = undefined
    }
    if (originalFindFirst) {
      ;(prisma.message as unknown as { findFirst: typeof originalFindFirst }).findFirst = originalFindFirst
      originalFindFirst = undefined
    }
  })

  test('returns 0 when lastWakeAt is null (cold start avoids drowning bot in history)', async () => {
    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)
    const result = await replayMissedMessages({ mailboxCursors: {}, legacyLastWakeAt: null }, {
      enqueueMessageEvent: enq,
      selfNumber: 999,
      groupIds: [672312932],
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
        mentionedSelf: true,
      }),
      makeGroupRow({
        id: 101,
        groupId: 672312932,
        messageId: 2,
        senderId: 555,
        text: 'only in replay',
        createdAt: new Date('2026-05-04T01:00:02Z'),
        mentionedSelf: true,
      }),
      makeGroupRow({
        id: 102,
        groupId: 672312932,
        messageId: 3,
        senderId: 555,
        text: 'also live first',
        createdAt: new Date('2026-05-04T01:00:03Z'),
        mentionedSelf: true,
      }),
    ]
    installFindManyRows(rows)

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
      mentionedSelf: true,
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
      mentionedSelf: true,
      sentAt: new Date(),
      renderedText: 'also live first',
    })
    assert.equal(q.size(), 2, 'pre-replay state')

    const result = await replayMissedMessages({ mailboxCursors: {}, legacyLastWakeAt: lastWake }, {
      enqueueMessageEvent: enq,
      selfNumber: 999,
      groupIds: [672312932],
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

  test('replay enqueues only mentioned group rows plus private rows from mixed-source DB rows', async () => {
    const lastWake = new Date('2026-05-04T00:00:00Z')
    const rows: Message[] = [
      makeGroupRow({
        id: 1,
        groupId: 672312932,
        messageId: 1,
        senderId: 555,
        text: 'group msg',
        createdAt: new Date('2026-05-04T00:01:00Z'),
        mentionedSelf: true,
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
    installFindManyRows(rows)

    const q = new InMemoryEventQueue<BotEvent>()
    const enq = createDedupEnqueue(q)
    const result = await replayMissedMessages({ mailboxCursors: {}, legacyLastWakeAt: lastWake }, {
      enqueueMessageEvent: enq,
      selfNumber: 999,
      groupIds: [672312932],
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

  test('leaves unmentioned group rows passive during replay without preparing their bodies', async () => {
    const rows = [makeGroupRow({
      id: 5,
      groupId: 672312932,
      messageId: 5,
      senderId: 555,
      text: '普通群聊',
      createdAt: new Date('2026-05-04T00:01:00Z'),
    })]
    installFindManyRows(rows)
    let ensureReadyCalls = 0

    const q = new InMemoryEventQueue<BotEvent>()
    const result = await replayMissedMessages({
      mailboxCursors: { 'qq_group:672312932': 4 },
      legacyLastWakeAt: null,
    }, {
      enqueueMessageEvent: createDedupEnqueue(q),
      selfNumber: 999,
      groupIds: [672312932],
      ensureReady: async (message) => {
        ensureReadyCalls++
        return stubEnsureReady(message)
      },
    })

    assert.deepEqual(result, { enqueued: 0, skippedDuplicates: 0 })
    assert.equal(ensureReadyCalls, 0)
    assert.equal(q.size(), 0)
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
        mentionedSelf: true,
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
    installFindManyRows(rows)

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
      groupIds: [672312932],
      ensureReady: stubEnsureReady,
    })

    assert.deepEqual(result, { enqueued: 2, skippedDuplicates: 0 })
    const rowIds: number[] = []
    while (q.size() > 0) {
      const event = q.dequeue()
      if (event && 'messageRowId' in event) rowIds.push(event.messageRowId)
    }
    rowIds.sort((a, b) => a - b)
    assert.deepEqual(rowIds, [11, 12])
  })

  test('discovers new private sources by legacy wake boundary when other cursors exist', async () => {
    const rows: Message[] = [
      makePrivateRow({
        id: 20,
        peerId: 10001,
        messageId: 20,
        senderId: 10001,
        text: 'known private after cursor',
        createdAt: new Date('2026-05-04T01:00:00Z'),
      }),
      makePrivateRow({
        id: 21,
        peerId: 30003,
        messageId: 21,
        senderId: 30003,
        text: 'new private source after wake',
        createdAt: new Date('2026-05-04T01:01:00Z'),
      }),
      makePrivateRow({
        id: 22,
        peerId: 30003,
        messageId: 22,
        senderId: 30003,
        text: 'second message from new source',
        createdAt: new Date('2026-05-04T01:02:00Z'),
      }),
      makePrivateRow({
        id: 23,
        peerId: 40004,
        messageId: 23,
        senderId: 40004,
        text: 'new private before wake',
        createdAt: new Date('2026-05-03T23:59:00Z'),
      }),
    ]
    installFindManyRows(rows)

    const q = new InMemoryEventQueue<BotEvent>()
    const result = await replayMissedMessages({
      mailboxCursors: {
        'qq_group:672312932': 10,
        'qq_private:10001': 19,
      },
      legacyLastWakeAt: new Date('2026-05-04T00:00:00Z'),
    }, {
      enqueueMessageEvent: createDedupEnqueue(q),
      selfNumber: 999,
      groupIds: [672312932],
      ensureReady: stubEnsureReady,
    })

    assert.deepEqual(result, { enqueued: 3, skippedDuplicates: 0 })
    const rowIds: number[] = []
    while (q.size() > 0) {
      const event = q.dequeue()
      if (event && 'messageRowId' in event) rowIds.push(event.messageRowId)
    }
    rowIds.sort((a, b) => a - b)
    assert.deepEqual(rowIds, [20, 21, 22])
  })

  test('filters a large group backlog in the database and prepares only mentioned rows', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => makeGroupRow({
      id: 1_000 + index,
      groupId: 672312932,
      messageId: 10_000 + index,
      senderId: 555,
      text: `probe-${index}`,
      createdAt: new Date('2026-05-04T01:00:00Z'),
      groupName: '积压群',
      mentionedSelf: index === 500,
    }))
    const findManyCalls = installFindManyRows(rows)

    let ensureReadyCalls = 0
    const q = new InMemoryEventQueue<BotEvent>()
    const result = await replayMissedMessages({
      mailboxCursors: { 'qq_group:672312932': 999 },
      legacyLastWakeAt: null,
    }, {
      enqueueMessageEvent: createDedupEnqueue(q),
      selfNumber: 999,
      groupIds: [672312932],
      ensureReady: async (message) => {
        ensureReadyCalls++
        return stubEnsureReady(message)
      },
    })

    assert.deepEqual(result, { enqueued: 1, skippedDuplicates: 0 })
    assert.equal(ensureReadyCalls, 1)
    assert.deepEqual(findManyCalls[0]?.where?.content, {
      array_contains: [{ type: 'at', targetId: '999' }],
    })
    const event = q.dequeue()
    assert.equal(event?.type, 'napcat_message')
    assert.equal(event && 'messageRowId' in event ? event.messageRowId : null, 1_500)
  })
})
