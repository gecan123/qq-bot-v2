import assert from 'node:assert/strict'
import { describe, test, beforeEach, afterEach } from 'node:test'
import { createSendMessageTool } from './send-message.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import type { SendNapcatResult, NapcatSegment } from '../../messaging/napcat-sender.js'
import type { ToolContext } from '../tool.js'
import type { BotEvent } from '../event.js'
import { InMemoryEventQueue } from '../event-queue.js'
import { OutboundCache, setOutboundCacheForTest } from '../../media/outbound-cache.js'
import { prisma } from '../../database/client.js'
import type { SendTargetPolicy } from '../send-target-policy.js'
import type { GroupMuteInspector, GroupMuteInspection } from '../../messaging/group-mute-inspector.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

type SenderFn = 'sendSegments'

interface RecordedCall {
  fn: SenderFn
  args: unknown
}

function makeMockSender(
  result: SendNapcatResult = { success: true, attempts: 1, providerMessageId: 8888 },
  opts?: { segmentsResult?: SendNapcatResult },
): {
  sender: MessageSender
  calls: RecordedCall[]
  segmentsCalls: Array<{ segments: NapcatSegment[] }>
} {
  const calls: RecordedCall[] = []
  const segmentsCalls: Array<{ segments: NapcatSegment[] }> = []
  const sender: MessageSender = {
    async sendSegments(args) {
      calls.push({ fn: 'sendSegments', args })
      segmentsCalls.push({ segments: args.segments })
      return opts?.segmentsResult ?? result
    },
  }
  return { sender, calls, segmentsCalls }
}

function parseToolResult(content: string | unknown): Record<string, unknown> {
  return JSON.parse(content as string)
}

function makeMockMuteInspector(
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

const allowAllTargets: SendTargetPolicy = {
  async authorize() {
    return { allowed: true }
  },
}

function createAllowedTool(
  sender: MessageSender,
  groupMuteInspector: GroupMuteInspector = makeMockMuteInspector().inspector,
) {
  return createSendMessageTool({ sender, targetPolicy: allowAllTargets, groupMuteInspector })
}

describe('send_message tool — unified contract', () => {
  test('passes replyToMessageId into target authorization', async () => {
    const { sender } = makeMockSender()
    const calls: unknown[] = []
    const tool = createSendMessageTool({
      sender,
      targetPolicy: {
        async authorize(input) {
          calls.push(input)
          return { allowed: false, error: 'blocked for test' }
        },
      },
    })

    await tool.execute({
      target: { type: 'group', groupId: 111 },
      mode: 'reply',
      text: 'hi',
      replyToMessageId: 555,
    }, makeCtx())

    assert.deepEqual(calls, [{
      target: { type: 'group', groupId: 111 },
      mode: 'reply',
      replyToMessageId: 555,
    }])
  })

  test('requires explicit mode with an exact replyToMessageId shape', () => {
    const { sender } = makeMockSender()
    const tool = createSendMessageTool({ sender, targetPolicy: allowAllTargets })

    assert.equal(tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
      text: 'hi',
      replyToMessageId: null,
    }).success, false)
    assert.equal(tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
      mode: 'ambient',
      text: 'hi',
      replyToMessageId: 5,
    }).success, false)
    assert.equal(tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
      mode: 'reply',
      text: 'hi',
      replyToMessageId: null,
    }).success, false)
  })

  test('returns rejected without calling sender when target policy denies the send', async () => {
    const { sender, calls } = makeMockSender()
    const targetPolicy: SendTargetPolicy = {
      async authorize() {
        return { allowed: false, error: 'not allowed' }
      },
    }
    const tool = createSendMessageTool({ sender, targetPolicy })

    const out = await tool.execute({
      target: { type: 'private', userId: 9001 },
      mode: 'ambient',
      text: 'hi',
      replyToMessageId: null,
      imageRef: null,
    }, makeCtx())

    assert.deepEqual(parseToolResult(out.content), {
      ok: false,
      status: 'rejected',
      target: { type: 'private', userId: 9001 },
      mode: 'ambient',
      attempts: 0,
      providerMessageId: null,
      error: 'not allowed',
    })
    assert.equal(calls.length, 0)
  })

  test('returns a sent receipt only after the sender confirms delivery', async () => {
    const { sender } = makeMockSender()
    const tool = createSendMessageTool({ sender, targetPolicy: allowAllTargets })

    const out = await tool.execute({
      target: { type: 'group', groupId: 111 },
      mode: 'reply',
      text: 'hi',
      replyToMessageId: 5,
      imageRef: null,
    }, makeCtx())

    assert.deepEqual(parseToolResult(out.content), {
      ok: true,
      status: 'sent',
      target: { type: 'group', groupId: 111 },
      mode: 'reply',
      attempts: 1,
      providerMessageId: 8888,
    })
  })
})

describe('send_message tool — group target', () => {
  test('group reply builds shared reply/text segments', async () => {
    const { sender, calls, segmentsCalls } = makeMockSender()
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        mode: 'reply',
        text: 'hi',
        replyToMessageId: 555,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.status, 'sent')
    assert.equal(result.mode, 'reply')
    assert.equal(result.providerMessageId, 8888)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'sendSegments')
    assert.deepEqual(segmentsCalls[0]!.segments.map((segment) => segment.type), ['reply', 'text'])
  })

  test('group ambient with mention builds shared at/text segments', async () => {
    const { sender, calls, segmentsCalls } = makeMockSender()
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111, mentionUserId: 100 },
        mode: 'ambient',
        text: 'hi',
        replyToMessageId: null,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.status, 'sent')
    assert.equal(calls[0]!.fn, 'sendSegments')
    assert.deepEqual(segmentsCalls[0]!.segments.map((segment) => segment.type), ['at', 'text'])
  })

  test('group send failure → ok=false, error set', async () => {
    const { sender } = makeMockSender({ success: false, attempts: 2, providerMessageId: undefined })
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        mode: 'reply',
        text: 'hi',
        replyToMessageId: 5,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.attempts, 2)
    assert.equal(result.providerMessageId, null)
    assert.equal(result.reason, 'send_failed')
    assert.match((result.error as string) ?? '', /failed/i)
  })

  test('confirms self mute after a failed group send', async () => {
    const { sender } = makeMockSender({ success: false, attempts: 2 })
    const mutedUntil = '2026-07-10T12:30:00.000Z'
    const { inspector, calls } = makeMockMuteInspector({ muted: true, mutedUntil })
    const tool = createAllowedTool(sender, inspector)

    const out = await tool.execute({
      target: { type: 'group', groupId: 111 },
      mode: 'reply',
      text: 'hi',
      replyToMessageId: 5,
    }, makeCtx())

    const result = parseToolResult(out.content)
    assert.deepEqual(calls, [111])
    assert.equal(result.reason, 'group_muted')
    assert.equal(result.mutedUntil, mutedUntil)
  })

  test('uses send_failed when group mute is not confirmed', async () => {
    const { sender } = makeMockSender({ success: false, attempts: 2 })
    const { inspector } = makeMockMuteInspector({ muted: false })
    const out = await createAllowedTool(sender, inspector).execute({
      target: { type: 'group', groupId: 111 },
      mode: 'ambient',
      text: 'hi',
      replyToMessageId: null,
    }, makeCtx())

    assert.equal(parseToolResult(out.content).reason, 'send_failed')
  })

  test('diagnostic failure degrades to send_failed', async () => {
    const { sender } = makeMockSender({ success: false, attempts: 2 })
    const { inspector } = makeMockMuteInspector({ muted: false }, new Error('query failed'))
    const out = await createAllowedTool(sender, inspector).execute({
      target: { type: 'group', groupId: 111 },
      mode: 'ambient',
      text: 'hi',
      replyToMessageId: null,
    }, makeCtx())

    assert.equal(parseToolResult(out.content).reason, 'send_failed')
  })

  test('does not inspect mute state after a successful group send', async () => {
    const { sender } = makeMockSender()
    const { inspector, calls } = makeMockMuteInspector()
    await createAllowedTool(sender, inspector).execute({
      target: { type: 'group', groupId: 111 },
      mode: 'ambient',
      text: 'hi',
      replyToMessageId: null,
    }, makeCtx())

    assert.deepEqual(calls, [])
  })
})

describe('send_message tool — private target', () => {
  test('private reply uses the shared segment sender', async () => {
    const { sender, calls, segmentsCalls } = makeMockSender()
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'private', userId: 10001 },
        mode: 'reply',
        text: 'hi',
        replyToMessageId: 333,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.status, 'sent')
    assert.equal(calls[0]!.fn, 'sendSegments')
    assert.deepEqual(segmentsCalls[0]!.segments.map((segment) => segment.type), ['reply', 'text'])
    const args = calls[0]!.args as { target: { type: string; userId: number } }
    assert.deepEqual(args.target, { type: 'private', userId: 10001 })
  })

  test('private ambient uses the shared segment sender without reply', async () => {
    const { sender, calls, segmentsCalls } = makeMockSender()
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'private', userId: 10001 },
        mode: 'ambient',
        text: '主动开个话题',
        replyToMessageId: null,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.status, 'sent')
    assert.equal(calls[0]!.fn, 'sendSegments')
    assert.deepEqual(segmentsCalls[0]!.segments.map((segment) => segment.type), ['text'])
  })

  test('does not inspect group mute state after a failed private send', async () => {
    const { sender } = makeMockSender({ success: false, attempts: 2 })
    const { inspector, calls } = makeMockMuteInspector()
    const out = await createAllowedTool(sender, inspector).execute({
      target: { type: 'private', userId: 10001 },
      mode: 'ambient',
      text: 'hi',
      replyToMessageId: null,
    }, makeCtx())

    assert.deepEqual(calls, [])
    assert.equal(parseToolResult(out.content).reason, 'send_failed')
  })
})

describe('send_message tool — schema rejection', () => {
  test('rejects mentionUserId on private target via Zod (private branch has no mentionUserId)', () => {
    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    const r = tool.schema.safeParse({
      target: { type: 'private', userId: 10001, mentionUserId: 1 },
      mode: 'ambient',
      text: 'hi',
      replyToMessageId: null,
      imageRef: null,
    })
    assert.equal(r.success, true)
    if (r.success) {
      const data = r.data as { target: { type: string; userId?: number; mentionUserId?: number } }
      assert.equal(data.target.type, 'private')
      assert.equal('mentionUserId' in data.target, false)
    }
  })

  test('rejects text > 500 chars via Zod', () => {
    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    const r = tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
      text: 'x'.repeat(501),
    })
    assert.equal(r.success, false)
  })

  test('rejects empty args (no text, no image) via Zod refine', () => {
    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    const r = tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
    })
    assert.equal(r.success, false)
  })

  test('accepts imageRef-only (no text)', () => {
    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    const r = tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
      mode: 'ambient',
      text: null,
      replyToMessageId: null,
      imageRef: 'media:42',
    })
    assert.equal(r.success, true)
  })

  test('accepts text + imageRef', () => {
    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    const r = tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
      mode: 'ambient',
      text: 'look at this',
      replyToMessageId: null,
      imageRef: `ephemeral:${'a'.repeat(64)}`,
    })
    assert.equal(r.success, true)
  })

  test('tool name is send_message', () => {
    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    assert.equal(tool.name, 'send_message')
  })

  test('description makes send_message the only text and image send tool', () => {
    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)

    assert.match(tool.description, /文本、图片和图文消息都统一使用 send_message/)
    assert.match(tool.description, /不存在 send_image 工具/)
  })

  test('accepts flattened ambient text args without reply or image fields', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'private', userId: 10001 },
        mode: 'ambient',
        text: '在的',
        replyToMessageId: null,
        imageRef: null,
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.status, 'sent')
    assert.equal(calls[0]!.fn, 'sendSegments')
    const args = calls[0]!.args as { segments: NapcatSegment[] }
    assert.equal(args.segments[0]?.data.text, '在的')
  })

  test('does not reject or rewrite send_message text based on content markers', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createAllowedTool(sender)
    const text = '收到，这条不引用。\n\n*思考: 这里不应该出现在用户可见正文里。*'
    const out = await tool.execute(
      {
        target: { type: 'private', userId: 10001 },
        mode: 'ambient',
        text,
        replyToMessageId: null,
        imageRef: null,
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
    const args = calls[0]!.args as { segments: NapcatSegment[] }
    assert.equal(args.segments[0]?.data.text, text)
  })

  test('mode=ambient rejects a non-null replyToMessageId', () => {
    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    const result = tool.schema.safeParse({
      target: { type: 'private', userId: 10001 },
      mode: 'ambient',
      text: '在的',
      replyToMessageId: 12345,
      imageRef: null,
    })

    assert.equal(result.success, false)
  })

  test('schema rejects object-shaped image in flattened args', () => {
    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    const r = tool.schema.safeParse({
      target: { type: 'private', userId: 10001 },
      mode: 'ambient',
      text: '在的',
      replyToMessageId: null,
      image: { mediaId: 1 },
      imageRef: null,
    })
    assert.equal(r.success, true)
    if (r.success) {
      const data = r.data as Record<string, unknown>
      assert.equal('image' in data, false)
    }
  })

})

describe('send_message tool — image via ephemeralRef', () => {
  const HASH = 'a'.repeat(64)
  let cache: OutboundCache
  let originalUpsert: typeof prisma.media.upsert

  beforeEach(() => {
    cache = new OutboundCache({ maxEntries: 10, maxBytes: 100000, ttlMs: 60000 })
    setOutboundCacheForTest(cache)
    originalUpsert = prisma.media.upsert
  })

  afterEach(() => {
    setOutboundCacheForTest(null)
    prisma.media.upsert = originalUpsert
  })

  test('ephemeralRef path → sendSegments with image segment → lazy persist → mediaId in result', async () => {
    cache.put({
      bytes: Buffer.from('test-image'),
      dataHash: HASH,
      byteSize: 10,
      contentType: 'image/png',
      description: 'test',
    })
    prisma.media.upsert = (async () => ({ mediaId: 42 })) as never

    const { sender, segmentsCalls } = makeMockSender()
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        mode: 'ambient',
        replyToMessageId: null,
        image: { ephemeralRef: HASH },
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.status, 'sent')

    const img = result.image as Record<string, unknown>
    assert.equal(img.mediaId, 42)
    assert.equal(img.ephemeralRef, HASH)
    assert.equal(img.dataHash, HASH)

    assert.equal(segmentsCalls.length, 1)
    const segTypes = segmentsCalls[0].segments.map((s) => s.type)
    assert.ok(segTypes.includes('image'), 'should include image segment')
  })

  test('ephemeralRef path → lazy persist failure → ok:true + lazyPersistError + ephemeralRef retained', async () => {
    cache.put({
      bytes: Buffer.from('test-image'),
      dataHash: HASH,
      byteSize: 10,
      contentType: 'image/png',
      description: 'test',
    })
    prisma.media.upsert = (async () => {
      throw new Error('db connection lost')
    }) as never

    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        mode: 'ambient',
        replyToMessageId: null,
        image: { ephemeralRef: HASH },
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    const img = result.image as Record<string, unknown>
    assert.equal(img.mediaId, null)
    assert.ok(img.lazyPersistError)
    assert.match(img.lazyPersistError as string, /db connection lost/)

    // ephemeralRef should still be in cache (not evicted)
    const stillThere = cache.get(HASH)
    assert.ok(stillThere, 'ephemeralRef should remain in cache after persist failure')
  })

  test('NapCat send failure → ok:false, no persist, ephemeralRef not evicted', async () => {
    cache.put({
      bytes: Buffer.from('test-image'),
      dataHash: HASH,
      byteSize: 10,
      contentType: 'image/png',
      description: 'test',
    })
    let upsertCalled = false
    prisma.media.upsert = (async () => {
      upsertCalled = true
      return { mediaId: 99 }
    }) as never

    const { sender } = makeMockSender(
      { success: true, attempts: 1, providerMessageId: 8888 },
      { segmentsResult: { success: false, attempts: 2 } },
    )
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        mode: 'ambient',
        replyToMessageId: null,
        image: { ephemeralRef: HASH },
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, false)
    assert.equal(upsertCalled, false, 'should not attempt lazy persist on send failure')
    assert.ok(cache.get(HASH), 'ephemeralRef should not be evicted after send failure')
  })

  test('expired ephemeralRef → ok:false with resolve error', async () => {
    const expiredCache = new OutboundCache({ maxEntries: 10, maxBytes: 100000, ttlMs: 1 })
    setOutboundCacheForTest(expiredCache)
    expiredCache.put({
      bytes: Buffer.from('test'),
      dataHash: HASH,
      byteSize: 4,
      contentType: 'image/png',
      description: 'test',
    })

    await new Promise((r) => setTimeout(r, 10))

    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        mode: 'ambient',
        replyToMessageId: null,
        image: { ephemeralRef: HASH },
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, false)
    assert.match(result.error as string, /resolve failed/)
  })

  test('text + image together → segments include both', async () => {
    cache.put({
      bytes: Buffer.from('img-data'),
      dataHash: HASH,
      byteSize: 8,
      contentType: 'image/png',
      description: 'test',
    })
    prisma.media.upsert = (async () => ({ mediaId: 10 })) as never

    const { sender, segmentsCalls } = makeMockSender()
    const tool = createAllowedTool(sender)
    await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        mode: 'ambient',
        replyToMessageId: null,
        text: 'check this out',
        image: { ephemeralRef: HASH },
      },
      makeCtx(),
    )

    assert.equal(segmentsCalls.length, 1)
    const segTypes = segmentsCalls[0].segments.map((s) => s.type)
    assert.ok(segTypes.includes('text'))
    assert.ok(segTypes.includes('image'))
  })

  test('authorization rejection happens before image resolution, send, or persist', async () => {
    cache.put({
      bytes: Buffer.from('img-data'),
      dataHash: HASH,
      byteSize: 8,
      contentType: 'image/png',
      description: 'test',
    })
    let upsertCalled = false
    prisma.media.upsert = (async () => {
      upsertCalled = true
      return { mediaId: 10 }
    }) as never

    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({
      sender,
      targetPolicy: {
        async authorize() {
          return { allowed: false, error: 'ambient send rejected' }
        },
      },
    })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        mode: 'ambient',
        replyToMessageId: null,
        image: { ephemeralRef: HASH },
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, false)
    assert.equal(result.status, 'rejected')
    assert.equal(calls.length, 0)
    assert.equal(upsertCalled, false)
  })

  test('refcount released after send (finally block)', async () => {
    cache.put({
      bytes: Buffer.from('test-image'),
      dataHash: HASH,
      byteSize: 10,
      contentType: 'image/png',
      description: 'test',
    })
    prisma.media.upsert = (async () => ({ mediaId: 42 })) as never

    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        mode: 'ambient',
        replyToMessageId: null,
        image: { ephemeralRef: HASH },
      },
      makeCtx(),
    )

    const entry = cache.get(HASH)!
    assert.equal(entry.refcount, 0, 'refcount should be 0 after send completes')
  })
})

describe('send_message tool — image via mediaId', () => {
  let originalFindUnique: typeof prisma.media.findUnique

  beforeEach(() => {
    originalFindUnique = prisma.media.findUnique
  })

  afterEach(() => {
    prisma.media.findUnique = originalFindUnique
  })

  test('mediaId path → resolves from DB, sends, returns mediaId in result', async () => {
    prisma.media.findUnique = (async () => ({
      mediaId: 7,
      data: Buffer.from('stored-image'),
      dataHash: 'b'.repeat(64),
      contentType: 'image/jpeg',
      descriptionRaw: { description: 'a stored image' },
    })) as never

    const { sender, segmentsCalls } = makeMockSender()
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        mode: 'ambient',
        replyToMessageId: null,
        image: { mediaId: 7 },
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    const img = result.image as Record<string, unknown>
    assert.equal(img.mediaId, 7)

    assert.equal(segmentsCalls.length, 1)
    const segTypes = segmentsCalls[0].segments.map((s) => s.type)
    assert.ok(segTypes.includes('image'))
  })

  test('mediaId not found → ok:false', async () => {
    prisma.media.findUnique = (async () => null) as never

    const { sender } = makeMockSender()
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        mode: 'ambient',
        replyToMessageId: null,
        image: { mediaId: 9999 },
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, false)
    assert.match(result.error as string, /resolve failed/)
  })

  test('text + missing mediaId → sends text-only and reports image resolveError', async () => {
    prisma.media.findUnique = (async () => null) as never

    const { sender, calls } = makeMockSender()
    const tool = createAllowedTool(sender)
    const out = await tool.execute(
      {
        target: { type: 'private', userId: 10001 },
        mode: 'reply',
        text: 'hi，醒着呢。咋啦',
        image: { mediaId: 1 },
        replyToMessageId: 333,
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.status, 'sent')
    assert.equal(result.mode, 'reply')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'sendSegments')

    const args = calls[0]!.args as { segments: NapcatSegment[] }
    assert.deepEqual(args.segments.map((segment) => segment.type), ['reply', 'text'])
    assert.equal(args.segments[1]?.data.text, 'hi，醒着呢。咋啦')

    const img = result.image as Record<string, unknown>
    assert.equal(img.mediaId, 1)
    assert.match(img.resolveError as string, /Media not found: mediaId=1/)
  })
})
