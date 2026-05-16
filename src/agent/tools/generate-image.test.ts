import assert from 'node:assert/strict'
import { describe, test, beforeEach, afterEach } from 'node:test'
import { createGenerateImageTool } from './generate-image.js'
import { OutboundCache, setOutboundCacheForTest } from '../../media/outbound-cache.js'
import type { ToolContext } from '../tool.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'

const fakeCtx: ToolContext = {
  eventQueue: new InMemoryEventQueue<BotEvent>(),
  roundIndex: 0,
}

const FAKE_PNG = Buffer.from('fake-png-bytes-for-test')

describe('generate_image tool', () => {
  let cache: OutboundCache

  beforeEach(() => {
    cache = new OutboundCache()
    setOutboundCacheForTest(cache)
  })

  afterEach(() => {
    setOutboundCacheForTest(null)
  })

  test('generates image from prompt and returns ephemeralRef', async () => {
    const tool = createGenerateImageTool({
      generate: async () => FAKE_PNG,
    })

    const result = await tool.execute({ prompt: 'a cat in space' }, fakeCtx)
    const parsed = JSON.parse(result.content)

    assert.equal(parsed.ok, true)
    assert.equal(typeof parsed.ephemeralRef, 'string')
    assert.match(parsed.ephemeralRef, /^[a-f0-9]{64}$/)
    assert.equal(parsed.byteSize, FAKE_PNG.byteLength)
    assert.equal(parsed.contentType, 'image/png')
    assert.ok(parsed.description.includes('a cat in space'))

    const cached = cache.get(parsed.ephemeralRef)
    assert.ok(cached, 'image should be in outbound cache')
    assert.deepEqual(cached!.bytes, FAKE_PNG)
  })

  test('returns error when generate throws', async () => {
    const tool = createGenerateImageTool({
      generate: async () => { throw new Error('API quota exceeded') },
    })

    const result = await tool.execute({ prompt: 'anything' }, fakeCtx)
    const parsed = JSON.parse(result.content)

    assert.equal(parsed.ok, false)
    assert.ok(parsed.error.includes('API quota exceeded'))
    assert.equal(cache.size, 0)
  })

  test('returns error when source image handle is invalid', async () => {
    const tool = createGenerateImageTool({
      generate: async () => FAKE_PNG,
    })

    const result = await tool.execute(
      { prompt: 'edit this', image: { ephemeralRef: 'a'.repeat(64) } },
      fakeCtx,
    )
    const parsed = JSON.parse(result.content)

    assert.equal(parsed.ok, false)
    assert.ok(parsed.error.includes('源图片解析失败'))
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
    const tool = createGenerateImageTool({
      generate: async () => { throw new Error('should not be called') },
      edit: async (_prompt, _src) => {
        editCalled = true
        return FAKE_PNG
      },
    })

    const result = await tool.execute(
      { prompt: 'make it blue', image: { ephemeralRef: sourceHash } },
      fakeCtx,
    )
    const parsed = JSON.parse(result.content)

    assert.equal(parsed.ok, true)
    assert.ok(editCalled, 'edit function should have been called')
    assert.ok(parsed.description.includes('edited'))
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
    const tool = createGenerateImageTool({
      edit: async () => { throw new Error('edit failed') },
    })

    await tool.execute(
      { prompt: 'edit', image: { ephemeralRef: sourceHash } },
      fakeCtx,
    )

    const entry = cache.get(sourceHash)
    assert.ok(entry, 'source should still be in cache')
    assert.equal(entry!.refcount, 0, 'refcount should be released back to 0')
  })
})
