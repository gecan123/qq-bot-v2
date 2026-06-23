import assert from 'node:assert/strict'
import { describe, test, beforeEach, afterEach } from 'node:test'
import { createGenerateImageTool } from './generate-image.js'
import { OutboundCache, setOutboundCacheForTest } from '../../media/outbound-cache.js'
import type { ToolContext } from '../tool.js'
import type { ToolResultContent } from '../agent-context.types.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import { createInMemoryTaskRegistry } from '../background-task-registry.js'

function parseResultJson(content: ToolResultContent): Record<string, unknown> {
  if (typeof content === 'string') return JSON.parse(content) as Record<string, unknown>
  const textBlock = content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') throw new Error('No text block')
  return JSON.parse(textBlock.text) as Record<string, unknown>
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

const FAKE_PNG = Buffer.from('fake-png-bytes-for-test')

describe('generate_image tool', () => {
  let cache: OutboundCache
  let eventQueue: InMemoryEventQueue<BotEvent>
  let ctx: ToolContext

  beforeEach(() => {
    cache = new OutboundCache()
    setOutboundCacheForTest(cache)
    eventQueue = new InMemoryEventQueue<BotEvent>()
    ctx = { eventQueue, roundIndex: 0 }
  })

  afterEach(() => {
    setOutboundCacheForTest(null)
  })

  test('returns started immediately and completes in background', async () => {
    const taskRegistry = createInMemoryTaskRegistry()
    const tool = createGenerateImageTool({
      generate: async () => FAKE_PNG,
      taskRegistry,
    })

    const result = await tool.execute({ prompt: 'a cat in space' }, ctx)
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, true)
    assert.equal(parsed.status, 'started')
    assert.equal(typeof parsed.taskId, 'string')
    assert.ok((parsed.description as string).includes('a cat in space'))

    await flushMicrotasks()

    const task = taskRegistry.get(parsed.taskId as string)
    assert.ok(task)
    assert.equal(task!.status, 'completed')

    const cached = cache.get(task!.resultData as Record<string, unknown> & { ephemeralRef: string }
      ? (task!.resultData as Record<string, string>).ephemeralRef
      : '')
    assert.ok(cached, 'image should be in outbound cache')

    const event = eventQueue.dequeue()
    assert.ok(event)
    assert.equal(event!.type, 'background_task_completed')
    if (event!.type === 'background_task_completed') {
      assert.equal(event!.ok, true)
      assert.equal(event!.taskId, parsed.taskId)
    }
  })

  test('registers failure when generate throws', async () => {
    const taskRegistry = createInMemoryTaskRegistry()
    const tool = createGenerateImageTool({
      generate: async () => { throw new Error('API quota exceeded') },
      taskRegistry,
    })

    const result = await tool.execute({ prompt: 'anything' }, ctx)
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, true)
    assert.equal(parsed.status, 'started')

    await flushMicrotasks()

    const task = taskRegistry.get(parsed.taskId as string)
    assert.ok(task)
    assert.equal(task!.status, 'failed')
    assert.ok(task!.error!.includes('API quota exceeded'))

    assert.equal(cache.size, 0)

    const event = eventQueue.dequeue()
    assert.ok(event)
    assert.equal(event!.type, 'background_task_completed')
    if (event!.type === 'background_task_completed') {
      assert.equal(event!.ok, false)
    }
  })

  test('returns error synchronously when source image handle is invalid', async () => {
    const taskRegistry = createInMemoryTaskRegistry()
    const tool = createGenerateImageTool({
      generate: async () => FAKE_PNG,
      taskRegistry,
    })

    const result = await tool.execute(
      { prompt: 'edit this', image: { ephemeralRef: 'a'.repeat(64) } },
      ctx,
    )
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, false)
    assert.ok((parsed.error as string).includes('源图片解析失败'))
  })

  test('calls edit when source image is provided', async () => {
    const sourceHash = '0'.repeat(64)
    cache.put({
      bytes: Buffer.from('source-image'),
      dataHash: sourceHash,
      byteSize: 12,
      contentType: 'image/png',
      description: 'source',
    })

    let editCalled = false
    const taskRegistry = createInMemoryTaskRegistry()
    const tool = createGenerateImageTool({
      generate: async () => { throw new Error('should not be called') },
      edit: async (_prompt, _src) => {
        editCalled = true
        return FAKE_PNG
      },
      taskRegistry,
    })

    const result = await tool.execute(
      { prompt: 'make it blue', image: { ephemeralRef: sourceHash } },
      ctx,
    )
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, true)
    assert.equal(parsed.status, 'started')

    await flushMicrotasks()

    assert.ok(editCalled, 'edit function should have been called')

    const task = taskRegistry.get(parsed.taskId as string)
    assert.equal(task!.status, 'completed')
  })

  test('schema accepts quality, count, and up to five source images', () => {
    const taskRegistry = createInMemoryTaskRegistry()
    const tool = createGenerateImageTool({ taskRegistry })
    const handles = Array.from({ length: 5 }, (_, index) => ({ ephemeralRef: `${index}`.repeat(64) }))

    assert.equal(tool.schema.safeParse({ prompt: 'p', quality: 'low' }).success, true)
    assert.equal(tool.schema.safeParse({ prompt: 'p', quality: 'medium' }).success, true)
    assert.equal(tool.schema.safeParse({ prompt: 'p', quality: 'high' }).success, true)
    assert.equal(tool.schema.safeParse({ prompt: 'p', quality: 'ultra' }).success, false)
    assert.equal(tool.schema.safeParse({ prompt: 'p', count: 1 }).success, true)
    assert.equal(tool.schema.safeParse({ prompt: 'p', count: 4 }).success, true)
    assert.equal(tool.schema.safeParse({ prompt: 'p', count: 5 }).success, false)
    assert.equal(tool.schema.safeParse({ prompt: 'p', images: handles }).success, true)
    assert.equal(tool.schema.safeParse({ prompt: 'p', images: [...handles, { ephemeralRef: 'f'.repeat(64) }] }).success, false)
  })

  test('rejects args that provide both image and images', () => {
    const taskRegistry = createInMemoryTaskRegistry()
    const tool = createGenerateImageTool({ taskRegistry })

    assert.equal(tool.schema.safeParse({
      prompt: 'p',
      image: { ephemeralRef: '0'.repeat(64) },
      images: [{ ephemeralRef: '1'.repeat(64) }],
    }).success, false)
  })

  test('calls edit with every source image from images array', async () => {
    const sourceHash1 = '1'.repeat(64)
    const sourceHash2 = '2'.repeat(64)
    cache.put({
      bytes: Buffer.from('source-image-1'),
      dataHash: sourceHash1,
      byteSize: 14,
      contentType: 'image/png',
      description: 'source 1',
    })
    cache.put({
      bytes: Buffer.from('source-image-2'),
      dataHash: sourceHash2,
      byteSize: 14,
      contentType: 'image/png',
      description: 'source 2',
    })

    let editSources: Buffer[] = []
    let editQuality: unknown
    const taskRegistry = createInMemoryTaskRegistry()
    const tool = createGenerateImageTool({
      generate: async () => { throw new Error('should not be called') },
      edit: async (_prompt, sources, options) => {
        editSources = sources
        editQuality = options?.quality
        return FAKE_PNG
      },
      taskRegistry,
    })

    const result = await tool.execute(
      {
        prompt: 'combine them',
        quality: 'high',
        images: [{ ephemeralRef: sourceHash1 }, { ephemeralRef: sourceHash2 }],
      },
      ctx,
    )
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, true)
    await flushMicrotasks()

    assert.equal(editSources.length, 2)
    assert.equal(editSources[0].toString(), 'source-image-1')
    assert.equal(editSources[1].toString(), 'source-image-2')
    assert.equal(editQuality, 'high')
  })

  test('releases source handle even on generation failure', async () => {
    const sourceHash = '0'.repeat(64)
    cache.put({
      bytes: Buffer.from('source-image'),
      dataHash: sourceHash,
      byteSize: 12,
      contentType: 'image/png',
      description: 'source',
    })
    const taskRegistry = createInMemoryTaskRegistry()
    const tool = createGenerateImageTool({
      edit: async () => { throw new Error('edit failed') },
      taskRegistry,
    })

    await tool.execute(
      { prompt: 'edit', image: { ephemeralRef: sourceHash } },
      ctx,
    )

    await flushMicrotasks()

    const entry = cache.get(sourceHash)
    assert.ok(entry, 'source should still be in cache')
    assert.equal(entry!.refcount, 0, 'refcount should be released back to 0')
  })
})
