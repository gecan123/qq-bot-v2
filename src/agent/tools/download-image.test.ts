import assert from 'node:assert/strict'
import { describe, test, beforeEach, afterEach } from 'node:test'
import { createDownloadImageTool } from './download-image.js'
import { OutboundCache, setOutboundCacheForTest } from '../../media/outbound-cache.js'
import type { ToolContext } from '../tool.js'
import type { ToolResultContent } from '../agent-context.types.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseResultJson(content: ToolResultContent): any {
  if (typeof content === 'string') return JSON.parse(content)
  const textBlock = content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') throw new Error('No text block')
  return JSON.parse(textBlock.text)
}

const fakeCtx: ToolContext = {
  eventQueue: new InMemoryEventQueue<BotEvent>(),
  roundIndex: 0,
}

const FAKE_PNG = Buffer.from('fake-png-bytes-for-test')

function fakeImageResponse(
  bytes: Buffer = FAKE_PNG,
  contentType = 'image/png',
  status = 200,
): Response {
  return new Response(new Uint8Array(bytes), {
    status,
    headers: { 'content-type': contentType },
  })
}

describe('download_image tool', () => {
  let cache: OutboundCache

  beforeEach(() => {
    cache = new OutboundCache()
    setOutboundCacheForTest(cache)
  })

  afterEach(() => {
    setOutboundCacheForTest(null)
  })

  test('downloads image and returns ephemeralRef', async () => {
    const tool = createDownloadImageTool({
      fetcher: async () => fakeImageResponse(),
    })

    const result = await tool.execute(
      { url: 'https://example.com/cat.png' },
      fakeCtx,
    )
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, true)
    assert.match(parsed.ephemeralRef, /^[a-f0-9]{64}$/)
    assert.equal(parsed.byteSize, FAKE_PNG.byteLength)
    assert.equal(parsed.contentType, 'image/png')
    assert.equal(typeof parsed.description, 'string')

    const cached = cache.get(parsed.ephemeralRef)
    assert.ok(cached, 'image should be in outbound cache')
    assert.deepEqual(cached!.bytes, FAKE_PNG)
  })

  test('rejects non-image content-type', async () => {
    const tool = createDownloadImageTool({
      fetcher: async () =>
        new Response('not an image', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    })

    const result = await tool.execute(
      { url: 'https://example.com/page.html' },
      fakeCtx,
    )
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, false)
    assert.ok(parsed.error.includes('content-type'))
    assert.equal(cache.size, 0)
  })

  test('handles HTTP error status', async () => {
    const tool = createDownloadImageTool({
      fetcher: async () => fakeImageResponse(FAKE_PNG, 'image/png', 404),
    })

    const result = await tool.execute(
      { url: 'https://example.com/missing.png' },
      fakeCtx,
    )
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, false)
    assert.ok(parsed.error.includes('404'))
  })

  test('handles fetch network error', async () => {
    const tool = createDownloadImageTool({
      fetcher: async () => {
        throw new Error('ECONNREFUSED')
      },
    })

    const result = await tool.execute(
      { url: 'https://example.com/down.png' },
      fakeCtx,
    )
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, false)
    assert.ok(parsed.error.includes('网络'))
  })

  test('handles fetch timeout (AbortError)', async () => {
    const tool = createDownloadImageTool({
      fetcher: async () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      },
    })

    const result = await tool.execute(
      { url: 'https://example.com/slow.png' },
      fakeCtx,
    )
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, false)
    assert.ok(parsed.error.includes('超时'))
  })

  test('truncates oversized image at IMAGE_MAX_BYTES boundary', async () => {
    const bigChunk = Buffer.alloc(11 * 1024 * 1024, 0x42)
    const tool = createDownloadImageTool({
      fetcher: async () => fakeImageResponse(bigChunk, 'image/jpeg'),
    })

    const result = await tool.execute(
      { url: 'https://example.com/huge.jpg' },
      fakeCtx,
    )
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, true)
    assert.ok(parsed.byteSize <= 10 * 1024 * 1024, 'should be capped at 10MB')

    const cached = cache.get(parsed.ephemeralRef)
    assert.ok(cached)
    assert.ok(cached!.bytes.byteLength <= 10 * 1024 * 1024)
  })

  test('accepts image/webp content-type', async () => {
    const tool = createDownloadImageTool({
      fetcher: async () => fakeImageResponse(FAKE_PNG, 'image/webp'),
    })

    const result = await tool.execute(
      { url: 'https://example.com/meme.webp' },
      fakeCtx,
    )
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, true)
    assert.equal(parsed.contentType, 'image/webp')
  })

  test('accepts content-type with charset suffix', async () => {
    const tool = createDownloadImageTool({
      fetcher: async () =>
        fakeImageResponse(FAKE_PNG, 'image/png; charset=utf-8'),
    })

    const result = await tool.execute(
      { url: 'https://example.com/cat.png' },
      fakeCtx,
    )
    const parsed = parseResultJson(result.content)

    assert.equal(parsed.ok, true)
    assert.equal(parsed.contentType, 'image/png')
  })

  test('description contains URL basename', async () => {
    const tool = createDownloadImageTool({
      fetcher: async () => fakeImageResponse(),
    })

    const result = await tool.execute(
      { url: 'https://cdn.reddit.com/funny-meme.png?v=123' },
      fakeCtx,
    )
    const parsed = parseResultJson(result.content)

    assert.ok(parsed.description.includes('funny-meme.png'))
  })
})
