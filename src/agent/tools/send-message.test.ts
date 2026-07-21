import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import type { BotEvent } from '../event.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { SendTargetPolicy } from '../send-target-policy.js'
import type { ToolContext } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import type { NapcatSegment, SendNapcatResult } from '../../messaging/napcat-sender.js'
import type { GroupMuteInspection, GroupMuteInspector } from '../../messaging/group-mute-inspector.js'
import { OutboundCache, setOutboundCacheForTest } from '../../media/outbound-cache.js'
import { prisma } from '../../database/client.js'
import type { QqConversationFocus } from '../agent-context.types.js'
import type { QqConversationController } from './qq-conversation.js'
import { createSendMessageTool } from './send-message.js'

type ActiveFocus = Exclude<QqConversationFocus, null>
const noWork = { state: 'none' as const }

function makeContext(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

function makeSender(
  result: SendNapcatResult = { success: true, attempts: 1, providerMessageId: 8888 },
): {
  sender: MessageSender
  calls: Array<{ target: ActiveFocus; segments: NapcatSegment[] }>
} {
  const calls: Array<{ target: ActiveFocus; segments: NapcatSegment[] }> = []
  return {
    calls,
    sender: {
      async sendSegments(args) {
        calls.push(args as { target: ActiveFocus; segments: NapcatSegment[] })
        return result
      },
    },
  }
}

function makeConversations(
  current: ActiveFocus | null,
  error?: 'CHAT_CONTEXT_UNAVAILABLE' | 'CHAT_CONTEXT_STALE',
): QqConversationController {
  return {
    getCurrent: () => current,
    async resolveCurrent() {
      if (error) return { ok: false, code: error }
      return current == null
        ? { ok: false, code: 'CHAT_CONTEXT_UNAVAILABLE' }
        : { ok: true, target: current }
    },
    async open(target) { return { ok: true, current: target } },
    close() {},
    async list() { return [] },
  }
}

const allowAllTargets: SendTargetPolicy = {
  async authorize() { return { allowed: true } },
}

function makeMuteInspector(
  result: GroupMuteInspection = { muted: false },
  error?: Error,
): { inspector: GroupMuteInspector; calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    inspector: {
      async inspect(groupId) {
        calls.push(groupId)
        if (error) throw error
        return result
      },
    },
  }
}

function createAllowedTool(
  sender: MessageSender,
  current: ActiveFocus = { type: 'group', groupId: 111 },
  groupMuteInspector: GroupMuteInspector = makeMuteInspector().inspector,
) {
  return createSendMessageTool({
    sender,
    targetPolicy: allowAllTargets,
    conversations: makeConversations(current),
    groupMuteInspector,
  })
}

function parse(content: unknown): Record<string, unknown> {
  return JSON.parse(content as string) as Record<string, unknown>
}

describe('send_message current conversation contract', () => {
  test('returns CHAT_CONTEXT_UNAVAILABLE before authorization or send', async () => {
    const { sender, calls } = makeSender()
    let authorizationCalls = 0
    const tool = createSendMessageTool({
      sender,
      conversations: makeConversations(null),
      targetPolicy: {
        async authorize() {
          authorizationCalls++
          return { allowed: true }
        },
      },
    })

    const result = await tool.execute({ message: 'hi', work: noWork }, makeContext())

    assert.deepEqual(parse(result.content), {
      ok: false,
      status: 'rejected',
      code: 'CHAT_CONTEXT_UNAVAILABLE',
      error: 'Open a QQ conversation before sending.',
    })
    assert.deepEqual(result.outcome, {
      ok: false,
      code: 'CHAT_CONTEXT_UNAVAILABLE',
      error: 'Open a QQ conversation before sending.',
    })
    assert.equal(authorizationCalls, 0)
    assert.equal(calls.length, 0)
  })

  test('returns CHAT_CONTEXT_STALE before authorization or send', async () => {
    const { sender, calls } = makeSender()
    let authorizationCalls = 0
    const tool = createSendMessageTool({
      sender,
      conversations: makeConversations(null, 'CHAT_CONTEXT_STALE'),
      targetPolicy: {
        async authorize() {
          authorizationCalls++
          return { allowed: true }
        },
      },
    })

    const result = await tool.execute({ message: 'hi', work: noWork }, makeContext())

    assert.equal(parse(result.content).code, 'CHAT_CONTEXT_STALE')
    assert.equal(result.outcome?.ok, false)
    assert.equal(result.outcome?.code, 'CHAT_CONTEXT_STALE')
    assert.equal(authorizationCalls, 0)
    assert.equal(calls.length, 0)
  })

  test('derives ambient and reply policy inputs from reply_to', async () => {
    const { sender, calls } = makeSender()
    const policyCalls: unknown[] = []
    const tool = createSendMessageTool({
      sender,
      conversations: makeConversations({ type: 'group', groupId: 111 }),
      targetPolicy: {
        async authorize(input) {
          policyCalls.push(input)
          return { allowed: true }
        },
      },
    })

    await tool.execute({ message: 'ambient', work: noWork }, makeContext())
    await tool.execute({ message: 'reply', reply_to: 555, work: noWork }, makeContext())

    assert.deepEqual(policyCalls, [
      {
        target: { type: 'group', groupId: 111 },
        mode: 'ambient',
        replyToMessageId: undefined,
      },
      {
        target: { type: 'group', groupId: 111 },
        mode: 'reply',
        replyToMessageId: 555,
      },
    ])
    assert.deepEqual(calls.map((call) => call.segments.map((segment) => segment.type)), [
      ['text'],
      ['reply', 'text'],
    ])
  })

  test('maps mention_user_id into a group mention segment', async () => {
    const { sender, calls } = makeSender()
    const tool = createAllowedTool(sender)

    await tool.execute({ message: 'hi', mention_user_id: 100, work: noWork }, makeContext())

    assert.deepEqual(calls[0]?.segments.map((segment) => segment.type), ['at', 'text'])
    assert.equal(calls[0]?.segments[0]?.data.qq, '100')
  })

  test('rejects mention_user_id in a private conversation before authorization', async () => {
    const { sender, calls } = makeSender()
    let authorizationCalls = 0
    const tool = createSendMessageTool({
      sender,
      conversations: makeConversations({ type: 'private', userId: 10001 }),
      targetPolicy: {
        async authorize() {
          authorizationCalls++
          return { allowed: true }
        },
      },
    })

    const result = await tool.execute({ message: 'hi', mention_user_id: 100, work: noWork }, makeContext())

    assert.equal(parse(result.content).code, 'MENTION_NOT_ALLOWED')
    assert.equal(result.outcome?.ok, false)
    assert.equal(result.outcome?.code, 'MENTION_NOT_ALLOWED')
    assert.equal(authorizationCalls, 0)
    assert.equal(calls.length, 0)
  })

  test('retains resolved target, mode, receipt, and message_sent effect', async () => {
    const { sender } = makeSender()
    const tool = createAllowedTool(sender, { type: 'private', userId: 10001 })

    const result = await tool.execute({ message: 'hi', reply_to: 333, work: noWork }, makeContext())

    assert.deepEqual(parse(result.content), {
      ok: true,
      status: 'sent',
      target: { type: 'private', userId: 10001 },
      mode: 'reply',
      attempts: 1,
      providerMessageId: 8888,
    })
    assert.deepEqual(result.effects, [{
      type: 'message_sent',
      target: { type: 'private', userId: 10001 },
    }])
    assert.deepEqual(result.outcome, { ok: true })
  })

  test('marks a successful continue send for one-round runtime continuation', async () => {
    const { sender } = makeSender()
    const tool = createAllowedTool(sender, { type: 'private', userId: 10001 })

    const result = await tool.execute({
      message: '我先看清楚结构，马上继续。',
      work: { state: 'continue' },
    }, makeContext())

    assert.deepEqual(result.effects, [{
      type: 'message_sent',
      target: { type: 'private', userId: 10001 },
      continueWork: true,
    }])
  })

  test('returns policy rejection without calling sender', async () => {
    const { sender, calls } = makeSender()
    const tool = createSendMessageTool({
      sender,
      conversations: makeConversations({ type: 'private', userId: 9001 }),
      targetPolicy: {
        async authorize() { return { allowed: false, error: 'not allowed' } },
      },
    })

    const result = await tool.execute({ message: 'hi', work: noWork }, makeContext())

    assert.deepEqual(parse(result.content), {
      ok: false,
      status: 'rejected',
      target: { type: 'private', userId: 9001 },
      mode: 'ambient',
      attempts: 0,
      providerMessageId: null,
      error: 'not allowed',
    })
    assert.equal(result.effects, undefined)
    assert.deepEqual(result.outcome, {
      ok: false,
      code: 'send_rejected',
      error: 'not allowed',
    })
    assert.equal(calls.length, 0)
  })
})

describe('send_message schema and content', () => {
  test('exposes the clean schema without target, mode, or replyToMessageId', () => {
    const { sender } = makeSender()
    const tool = createAllowedTool(sender)
    const shape = tool.schema.safeParse({
      message: 'hi',
      reply_to: 5,
      mention_user_id: 100,
      work: { state: 'none' },
    })

    assert.equal(shape.success, true)
    assert.equal(tool.schema.safeParse({ message: 'hi' }).success, false)
    assert.equal(tool.schema.safeParse({ message: 'x'.repeat(501), work: { state: 'none' } }).success, false)
    assert.equal(tool.schema.safeParse({ message: 'hi', reply_to: 0, work: { state: 'none' } }).success, false)
    assert.equal(tool.schema.safeParse({}).success, false)
    assert.equal(tool.schema.safeParse({ imageRef: 'media:42', work: { state: 'none' } }).success, true)
    assert.equal(tool.schema.safeParse({
      imageRef: `ephemeral:${'a'.repeat(64)}`,
      work: { state: 'none' },
    }).success, true)
    assert.equal(tool.schema.safeParse({ imageRef: 'bad', work: { state: 'none' } }).success, false)
    assert.equal(tool.schema.safeParse({
      message: '马上继续',
      work: { state: 'continue' },
    }).success, true)
    assert.equal(tool.schema.safeParse({
      message: '还在做',
      work: { state: 'goal_progress', goalId: '11111111-1111-4111-8111-111111111111' },
    }).success, true)
    assert.equal(tool.schema.safeParse({
      message: '还在做',
      work: { state: 'goal_progress', goalId: 'not-a-uuid' },
    }).success, false)
    assert.equal(tool.schema.safeParse({
      message: 'hi',
      work: { state: 'none' },
      target: { type: 'group', groupId: 1 },
    }).success, true)
    if (shape.success) {
      const data = shape.data as Record<string, unknown>
      assert.equal('target' in data, false)
      assert.equal('mode' in data, false)
      assert.equal('replyToMessageId' in data, false)
    }
  })

  test('sends platform music and validates custom music HTTPS fields', async () => {
    const { sender, calls } = makeSender()
    const tool = createAllowedTool(sender)
    const platformMusic = { platform: 'qq' as const, id: '004Z8Ihr0JIu5s' }

    assert.equal(tool.schema.safeParse({
      music: platformMusic,
      work: { state: 'none' },
    }).success, true)
    await tool.execute({ music: platformMusic, work: noWork }, makeContext())
    assert.deepEqual(calls[0]?.segments, [
      { type: 'music', data: { type: 'qq', id: '004Z8Ihr0JIu5s' } },
    ])
    assert.equal(tool.schema.safeParse({
      music: {
        platform: 'custom',
        url: 'https://example.com/song',
        image: 'https://example.com/cover.png',
        title: 'Luna Song',
      },
      work: { state: 'none' },
    }).success, true)
    assert.equal(tool.schema.safeParse({
      music: {
        platform: 'custom',
        url: 'http://example.com/song',
        image: 'https://example.com/cover.png',
        title: 'Luna Song',
      },
      work: { state: 'none' },
    }).success, false)
  })

  test('normalizes whitespace without filtering content markers', async () => {
    const { sender, calls } = makeSender()
    const tool = createAllowedTool(sender)
    const message = '  收到。  \n\n\n*思考: 用户可见正文*  '

    await tool.execute({ message, work: noWork }, makeContext())

    assert.equal(calls[0]?.segments[0]?.data.text, '收到。\n\n*思考: 用户可见正文*')
  })
})

describe('send_message failure diagnostics', () => {
  test('confirms group mute only after a failed group send', async () => {
    const { sender } = makeSender({ success: false, attempts: 2 })
    const mutedUntil = '2026-07-10T12:30:00.000Z'
    const { inspector, calls } = makeMuteInspector({ muted: true, mutedUntil })
    const tool = createAllowedTool(sender, { type: 'group', groupId: 111 }, inspector)

    const result = await tool.execute({ message: 'hi', work: noWork }, makeContext())

    assert.deepEqual(calls, [111])
    assert.equal(parse(result.content).reason, 'group_muted')
    assert.equal(parse(result.content).mutedUntil, mutedUntil)
    assert.deepEqual(result.outcome, {
      ok: false,
      code: 'group_muted',
      error: 'send failed (see SEND log)',
    })
    assert.equal(result.effects, undefined)
  })

  test('does not inspect mute for a failed private send', async () => {
    const { sender } = makeSender({ success: false, attempts: 2 })
    const { inspector, calls } = makeMuteInspector()
    const tool = createAllowedTool(sender, { type: 'private', userId: 10001 }, inspector)

    const result = await tool.execute({ message: 'hi', work: noWork }, makeContext())

    assert.deepEqual(calls, [])
    assert.equal(parse(result.content).reason, 'send_failed')
    assert.deepEqual(result.outcome, {
      ok: false,
      code: 'send_failed',
      error: 'send failed (see SEND log)',
    })
  })
})

describe('send_message image handling', () => {
  const hash = 'a'.repeat(64)
  let cache: OutboundCache
  let originalUpsert: typeof prisma.media.upsert
  let originalFindUnique: typeof prisma.media.findUnique

  beforeEach(() => {
    cache = new OutboundCache({ maxEntries: 10, maxBytes: 100_000, ttlMs: 60_000 })
    setOutboundCacheForTest(cache)
    originalUpsert = prisma.media.upsert
    originalFindUnique = prisma.media.findUnique
  })

  afterEach(() => {
    setOutboundCacheForTest(null)
    prisma.media.upsert = originalUpsert
    prisma.media.findUnique = originalFindUnique
  })

  function putEphemeral(): void {
    cache.put({
      bytes: Buffer.from('test-image'),
      dataHash: hash,
      byteSize: 10,
      contentType: 'image/png',
      description: 'test',
    })
  }

  test('sends an ephemeral image, persists it lazily, and releases its refcount', async () => {
    putEphemeral()
    prisma.media.upsert = (async () => ({ mediaId: 42 })) as never
    const { sender, calls } = makeSender()
    const tool = createAllowedTool(sender)

    const result = await tool.execute({ image: { ephemeralRef: hash }, work: noWork }, makeContext())

    assert.equal(parse(result.content).status, 'sent')
    assert.deepEqual(calls[0]?.segments.map((segment) => segment.type), ['image'])
    assert.deepEqual(parse(result.content).image, {
      mediaId: 42,
      ephemeralRef: hash,
      dataHash: hash,
      byteSize: 10,
      contentType: 'image/png',
    })
    assert.equal(cache.get(hash)?.refcount, 0)
  })

  test('keeps a successful send when lazy persistence fails', async () => {
    putEphemeral()
    prisma.media.upsert = (async () => { throw new Error('db connection lost') }) as never
    const { sender } = makeSender()

    const result = await createAllowedTool(sender).execute(
      { image: { ephemeralRef: hash }, work: noWork },
      makeContext(),
    )

    assert.equal(parse(result.content).status, 'sent')
    assert.match(String((parse(result.content).image as Record<string, unknown>).lazyPersistError), /db connection lost/)
    assert.ok(cache.get(hash))
  })

  test('does not persist an image after provider send failure', async () => {
    putEphemeral()
    let upsertCalled = false
    prisma.media.upsert = (async () => {
      upsertCalled = true
      return { mediaId: 99 }
    }) as never
    const { sender } = makeSender({ success: false, attempts: 2 })

    const result = await createAllowedTool(sender).execute(
      { image: { ephemeralRef: hash }, work: noWork },
      makeContext(),
    )

    assert.equal(parse(result.content).status, 'failed')
    assert.equal(upsertCalled, false)
    assert.equal(result.effects, undefined)
    assert.equal(result.outcome?.ok, false)
    assert.equal(result.outcome?.code, 'send_failed')
  })

  test('returns a stable resolve failure for an expired ephemeral image', async () => {
    const expiredCache = new OutboundCache({ maxEntries: 10, maxBytes: 100_000, ttlMs: 1 })
    setOutboundCacheForTest(expiredCache)
    expiredCache.put({
      bytes: Buffer.from('test'),
      dataHash: hash,
      byteSize: 4,
      contentType: 'image/png',
      description: 'test',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const { sender } = makeSender()

    const result = await createAllowedTool(sender).execute(
      { image: { ephemeralRef: hash }, work: noWork },
      makeContext(),
    )

    assert.equal(parse(result.content).status, 'failed')
    assert.match(String(parse(result.content).error), /resolve failed/)
    assert.equal(result.outcome?.ok, false)
    assert.equal(result.outcome?.code, 'image_resolve_failed')
  })

  test('authorizes before resolving or sending an image', async () => {
    putEphemeral()
    let upsertCalled = false
    prisma.media.upsert = (async () => {
      upsertCalled = true
      return { mediaId: 10 }
    }) as never
    const { sender, calls } = makeSender()
    const tool = createSendMessageTool({
      sender,
      conversations: makeConversations({ type: 'group', groupId: 111 }),
      targetPolicy: {
        async authorize() { return { allowed: false, error: 'ambient send rejected' } },
      },
    })

    const result = await tool.execute({ image: { ephemeralRef: hash }, work: noWork }, makeContext())

    assert.equal(parse(result.content).status, 'rejected')
    assert.equal(result.outcome?.ok, false)
    assert.equal(result.outcome?.code, 'send_rejected')
    assert.equal(calls.length, 0)
    assert.equal(upsertCalled, false)
    assert.equal(cache.get(hash)?.refcount, 0)
  })

  test('resolves and sends a persisted media image', async () => {
    prisma.media.findUnique = (async () => ({
      mediaId: 7,
      data: Buffer.from('stored-image'),
      dataHash: 'b'.repeat(64),
      contentType: 'image/jpeg',
      descriptionRaw: { description: 'stored' },
    })) as never
    const { sender, calls } = makeSender()

    const result = await createAllowedTool(sender).execute({
      imageRef: 'media:7',
      work: noWork,
    }, makeContext())

    assert.equal((parse(result.content).image as Record<string, unknown>).mediaId, 7)
    assert.deepEqual(calls[0]?.segments.map((segment) => segment.type), ['image'])
  })

  test('falls back to text when a persisted media image is missing', async () => {
    prisma.media.findUnique = (async () => null) as never
    const { sender, calls } = makeSender()
    const tool = createAllowedTool(sender, { type: 'private', userId: 10001 })

    const result = await tool.execute({
      message: 'hi，醒着呢。咋啦',
      imageRef: 'media:1',
      reply_to: 333,
      work: noWork,
    }, makeContext())

    assert.equal(parse(result.content).status, 'sent')
    assert.deepEqual(calls[0]?.segments.map((segment) => segment.type), ['reply', 'text'])
    assert.match(String((parse(result.content).image as Record<string, unknown>).resolveError), /Media not found/)
    assert.deepEqual(result.effects, [{
      type: 'message_sent',
      target: { type: 'private', userId: 10001 },
    }])
  })
})
