import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { describe, test } from 'node:test'
import * as zod from 'zod'
import { createInMemoryTaskRegistry } from '../background-task-registry.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import { buildBotTools } from './index.js'
import { createRedditTool } from './reddit.js'
import { createBackgroundTaskTool } from './background-task.js'
import { memoryTool } from './memory.js'
import { createFetchImageTool, runCurlImage } from './fetch-image.js'
import { prisma } from '../../database/client.js'
import { OutboundCache, setOutboundCacheForTest } from '../../media/outbound-cache.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }
}

const mockSender: MessageSender = {
  async replyToMessage() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
  async sendPrivateMessage() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
  async sendGroupMessage() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
  async sendSegments() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

describe('merged main-agent tools', () => {
  test('buildBotTools exposes merged entries and hides their old split entries', () => {
    const names = buildBotTools({
      sender: mockSender,
      groupAmbientSendIds: new Set(),
      taskRegistry: createInMemoryTaskRegistry(),
      groupIds: [],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
    }).map((tool) => tool.name)

    assert.ok(names.includes('reddit'))
    assert.ok(names.includes('background_task'))
    assert.ok(names.includes('memory'))
    assert.ok(names.includes('fetch_image'))
    assert.equal(names.includes('list_reddit'), false)
    assert.equal(names.includes('get_reddit_post'), false)
    assert.equal(names.includes('check_tasks'), false)
    assert.equal(names.includes('get_task_result'), false)
    assert.equal(names.includes('remember'), false)
    assert.equal(names.includes('recall'), false)
    assert.equal(names.includes('download_image'), false)
    assert.equal(names.includes('fetch_avatar'), false)
  })

  test('reddit action=list reuses list behavior and action=get_post reuses detail behavior', async () => {
    const writes: string[] = []
    const fetcher: typeof fetch = async (url) => {
      if (String(url).endsWith('/hot.rss')) {
        return new Response(`<feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <title>Story</title>
            <link href="https://www.reddit.com/r/technology/comments/abc/story/" rel="alternate"/>
            <summary type="html">summary</summary>
          </entry>
        </feed>`, { status: 200 })
      }
      return new Response(`<feed xmlns="http://www.w3.org/2005/Atom">
        <title>Story</title>
        <entry>
          <content type="html">nice comment</content>
          <author><name>/u/a</name></author>
        </entry>
      </feed>`, { status: 200 })
    }
    const tool = createRedditTool({
      fetcher,
      appender: async (_path, line) => {
        writes.push(line)
      },
    })

    const listed = await tool.execute({ action: 'list', subreddit: 'technology', sort: 'hot', limit: 10 }, makeCtx())
    const detailed = await tool.execute({
      action: 'get_post',
      url: 'https://www.reddit.com/r/technology/comments/abc/story/',
    }, makeCtx())

    assert.match(listed.content as string, /\[reddit \/r\/technology hot/)
    assert.match(detailed.content as string, /\[reddit post\]/)
    assert.equal(writes.length, 2)
  })

  test('reddit failure output names the merged reddit action instead of removed split tools', async () => {
    const fetcher: typeof fetch = async () => new Response('nope', { status: 404 })
    const tool = createRedditTool({ fetcher })

    const listed = await tool.execute({ action: 'list', subreddit: 'technology', sort: 'hot', limit: 10 }, makeCtx())
    const detailed = await tool.execute({
      action: 'get_post',
      url: 'https://www.reddit.com/r/technology/comments/abc/story/',
    }, makeCtx())

    assert.doesNotMatch(listed.content as string, /list_reddit/)
    assert.doesNotMatch(detailed.content as string, /get_reddit_post/)
    assert.match(listed.content as string, /\[reddit action=list HTTP 404\]/)
    assert.match(detailed.content as string, /\[reddit action=get_post HTTP 404\]/)
  })

  test('background_task action=list and action=get address the same registry', async () => {
    const registry = createInMemoryTaskRegistry()
    const task = registry.register({ toolName: 'generate_image', description: '生成图片' })
    registry.complete(task.id, { summary: 'done', data: { ephemeralRef: 'abc' } })
    const tool = createBackgroundTaskTool({ taskRegistry: registry })

    const listed = JSON.parse((await tool.execute({ action: 'list' }, makeCtx())).content as string) as {
      recentCompleted: { taskId: string }[]
    }
    const detail = await tool.execute({ action: 'get', taskId: task.id }, makeCtx())

    assert.equal(listed.recentCompleted[0]!.taskId, task.id)
    assert.match(JSON.stringify(detail.content), /abc/)
  })

  test('memory action=write and action=search preserve remember/recall behavior', async () => {
    const originalCreate = prisma.memoryEntry.create
    const originalFindMany = prisma.memoryEntry.findMany
    try {
      prisma.memoryEntry.create = (async () => ({ id: 42 })) as never
      prisma.memoryEntry.findMany = (async () => [
        { content: '喜欢冷笑话', createdAt: new Date('2026-06-01T00:00:00.000Z') },
      ]) as never

      const written = JSON.parse((await memoryTool.execute({
        action: 'write',
        target: { kind: 'person', id: 123 },
        content: '喜欢冷笑话',
      }, makeCtx())).content as string) as { ok: boolean; id: number }
      const recalled = JSON.parse((await memoryTool.execute({
        action: 'search',
        target: { kind: 'person', id: 123 },
      }, makeCtx())).content as string) as { entries: { content: string }[] }

      assert.equal(written.ok, true)
      assert.equal(written.id, 42)
      assert.equal(recalled.entries[0]!.content, '喜欢冷笑话')
      assert.doesNotThrow(() => zod.toJSONSchema(memoryTool.schema))
    } finally {
      prisma.memoryEntry.create = originalCreate
      prisma.memoryEntry.findMany = originalFindMany
    }
  })

  test('fetch_image action=url and action=qq_avatar both produce image handles', async () => {
    const cache = new OutboundCache()
    setOutboundCacheForTest(cache)
    try {
      const tool = createFetchImageTool({
        curl: async (url) => ({
          status: 200,
          contentType: String(url).includes('qlogo') ? 'image/png' : 'image/png',
          bytes: TINY_PNG,
          durationMs: 1,
        }),
      })

      const fromUrl = await tool.execute({ action: 'url', url: 'https://example.com/cat.png' }, makeCtx())
      const avatar = await tool.execute({ action: 'qq_avatar', qq: 123, size: '640' }, makeCtx())
      const parsedUrl = JSON.parse(Array.isArray(fromUrl.content) ? fromUrl.content[0]!.type === 'text' ? fromUrl.content[0]!.text : '{}' : fromUrl.content) as { ephemeralRef: string }
      const parsedAvatar = JSON.parse(Array.isArray(avatar.content) ? avatar.content[0]!.type === 'text' ? avatar.content[0]!.text : '{}' : avatar.content) as { ephemeralRef: string }

      assert.equal(Array.isArray(fromUrl.content), true)
      assert.equal(Array.isArray(avatar.content), true)
      assert.ok(Array.isArray(fromUrl.content) && fromUrl.content.some((block) => block.type === 'image'))
      assert.ok(Array.isArray(avatar.content) && avatar.content.some((block) => block.type === 'image'))
      assert.match(parsedUrl.ephemeralRef, /^[a-f0-9]{64}$/)
      assert.match(parsedAvatar.ephemeralRef, /^[a-f0-9]{64}$/)
      assert.ok(cache.get(parsedUrl.ephemeralRef))
      assert.ok(cache.get(parsedAvatar.ephemeralRef))
    } finally {
      setOutboundCacheForTest(null)
    }
  })

  test('runCurlImage fetches bytes from a local HTTP endpoint with curl', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(TINY_PNG)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const addr = server.address()
      assert.ok(addr && typeof addr === 'object')
      const result = await runCurlImage(`http://127.0.0.1:${addr.port}/tiny.png`, {
        timeoutMs: 2000,
        maxBytes: 1024 * 1024,
        userAgent: 'qq-bot-v2/test',
      })

      assert.equal(result.status, 200)
      assert.equal(result.contentType, 'image/png')
      assert.deepEqual(result.bytes, TINY_PNG)
      assert.equal(result.errorKind, undefined)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
