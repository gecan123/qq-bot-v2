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

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

type SenderFn = 'replyToMessage' | 'sendGroupMessage' | 'sendPrivateMessage' | 'sendSegments'

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
    async replyToMessage(args) {
      calls.push({ fn: 'replyToMessage', args })
      return result
    },
    async sendGroupMessage(args) {
      calls.push({ fn: 'sendGroupMessage', args })
      return result
    },
    async sendPrivateMessage(args) {
      calls.push({ fn: 'sendPrivateMessage', args })
      return result
    },
    async sendSegments(args) {
      calls.push({ fn: 'sendSegments', args })
      segmentsCalls.push({ segments: args.segments })
      return opts?.segmentsResult ?? result
    },
  }
  return { sender, calls, segmentsCalls }
}

function parseToolResult(content: string): Record<string, unknown> {
  return JSON.parse(content)
}

describe('send_message tool — group target', () => {
  test('group reply (replyToMessageId set) → sender.replyToMessage', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111, 999, 10001, 99999]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        text: 'hi',
        replyToMessageId: 555,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'group-reply')
    assert.equal(result.providerMessageId, 8888)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'replyToMessage')
  })

  test('group ambient (no replyToMessageId) → sender.sendGroupMessage', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111, 999, 10001, 99999]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        text: 'hi',
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.kind, 'group-ambient')
    assert.equal(calls[0]!.fn, 'sendGroupMessage')
  })

  test('group target with arbitrary groupId → 仍然真发 (group 不走工具层白名单, 准入由 ingress 负责)', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111, 999, 10001, 99999]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 999 },
        text: 'hi',
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'group-ambient')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'sendGroupMessage')
  })

  test('group reply with mentionUserId is forwarded to replyToMessage', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111, 999, 10001, 99999]) })
    await tool.execute(
      {
        target: { type: 'group', groupId: 111, mentionUserId: 100 },
        text: 'hi',
        replyToMessageId: 5,
      },
      makeCtx(),
    )
    const args = calls[0]!.args as { mentionUserId?: number }
    assert.equal(args.mentionUserId, 100)
  })

  test('group ambient 不在白名单 → ok=true 但不调用 sender (dry-run)', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([999]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        text: '主动开个话题',
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true, 'LLM 看到的是假成功')
    assert.equal(result.kind, 'group-ambient')
    assert.equal(result.providerMessageId, null, 'dry-run 没有真 providerMessageId')
    assert.equal(calls.length, 0, 'dry-run 不能调用任何 sender 方法')
  })

  test('group reply 不在 ambient 白名单仍然真发 (dry-run 只覆盖 ambient)', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([999]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        text: 'hi',
        replyToMessageId: 5,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'group-reply')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'replyToMessage', 'reply 路径不受 dry-run 影响, 真发')
  })

  test('group send failure → ok=false, error set', async () => {
    const { sender } = makeMockSender({ success: false, attempts: 2, providerMessageId: undefined })
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111, 999, 10001, 99999]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        text: 'hi',
        replyToMessageId: 5,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, false)
    assert.equal(result.attempts, 2)
    assert.equal(result.providerMessageId, null)
    assert.match((result.error as string) ?? '', /failed/i)
  })
})

describe('send_message tool — private target', () => {
  test('private reply → sender.sendPrivateMessage with replyToMessageId', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111, 999, 10001, 99999]) })
    const out = await tool.execute(
      {
        target: { type: 'private', userId: 10001 },
        text: 'hi',
        replyToMessageId: 333,
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'private-reply')
    assert.equal(calls[0]!.fn, 'sendPrivateMessage')
    const args = calls[0]!.args as { userId: number; text: string; replyToMessageId?: number }
    assert.equal(args.userId, 10001)
    assert.equal(args.replyToMessageId, 333)
  })

  test('private ambient (no replyToMessageId) → sender.sendPrivateMessage without reply', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111, 999, 10001, 99999]) })
    const out = await tool.execute(
      {
        target: { type: 'private', userId: 10001 },
        text: '主动开个话题',
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.kind, 'private-ambient')
    const args = calls[0]!.args as { replyToMessageId?: number }
    assert.equal(args.replyToMessageId, undefined)
  })

  test('private target with arbitrary userId → 仍然真发 (private 不走白名单)', async () => {
    const { sender, calls } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111, 999, 10001, 99999]) })
    const out = await tool.execute(
      {
        target: { type: 'private', userId: 99999 },
        text: 'hello',
      },
      makeCtx(),
    )
    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'private-ambient')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'sendPrivateMessage')
    const args = calls[0]!.args as { userId: number }
    assert.equal(args.userId, 99999)
  })
})

describe('send_message tool — schema rejection', () => {
  test('rejects mentionUserId on private target via Zod (private branch has no mentionUserId)', () => {
    const { sender } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111, 999, 10001, 99999]) })
    const r = tool.schema.safeParse({
      target: { type: 'private', userId: 10001, mentionUserId: 1 },
      text: 'hi',
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
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111, 999, 10001, 99999]) })
    const r = tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
      text: 'x'.repeat(501),
    })
    assert.equal(r.success, false)
  })

  test('rejects empty args (no text, no image) via Zod refine', () => {
    const { sender } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111]) })
    const r = tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
    })
    assert.equal(r.success, false)
  })

  test('accepts image-only (no text)', () => {
    const { sender } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111]) })
    const r = tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
      image: { mediaId: 42 },
    })
    assert.equal(r.success, true)
  })

  test('accepts text + image', () => {
    const { sender } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111]) })
    const r = tool.schema.safeParse({
      target: { type: 'group', groupId: 111 },
      text: 'look at this',
      image: { ephemeralRef: 'a'.repeat(64) },
    })
    assert.equal(r.success, true)
  })

  test('tool name is send_message', () => {
    const { sender } = makeMockSender()
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111, 999, 10001, 99999]) })
    assert.equal(tool.name, 'send_message')
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
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        image: { ephemeralRef: HASH },
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'group-ambient')

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
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
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
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
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
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
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
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111]) })
    await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
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

  test('dry-run with image → ok:true, no sendSegments, no persist', async () => {
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
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([999]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        image: { ephemeralRef: HASH },
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'group-ambient')
    assert.equal(calls.length, 0, 'dry-run should not call sender')
    assert.equal(upsertCalled, false, 'dry-run should not persist')
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
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111]) })
    await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
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
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
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
    const tool = createSendMessageTool({ sender, groupAmbientSendIds: new Set([111]) })
    const out = await tool.execute(
      {
        target: { type: 'group', groupId: 111 },
        image: { mediaId: 9999 },
      },
      makeCtx(),
    )

    const result = parseToolResult(out.content)
    assert.equal(result.ok, false)
    assert.match(result.error as string, /resolve failed/)
  })
})
