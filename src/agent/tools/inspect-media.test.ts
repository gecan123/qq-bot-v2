import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createInspectMediaTool } from './inspect-media.js'
import type { ToolContext } from '../tool.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import { createTaskScheduler } from '../task-scheduler.js'

const ctx: ToolContext = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
const resolvedImage = {
  bytes: Buffer.from('image-bytes'),
  dataHash: 'a'.repeat(64),
  byteSize: 11,
  contentType: 'image/png',
  description: '',
}
const compressed = {
  base64: Buffer.from('preview').toString('base64'),
  mediaType: 'image/jpeg' as const,
  byteSize: 7,
}

describe('inspect_media tool', () => {
  test('returns the existing description and a real image block', async () => {
    let describeCalls = 0
    const tool = createInspectMediaTool({
      loadMediaMetadata: async () => ({ mediaType: 'image', descriptionRaw: { description: '一只白猫' } }),
      describeMedia: async () => { describeCalls++ },
      resolveImage: async () => resolvedImage,
      compress: async () => compressed,
    })

    const result = await tool.execute({ image: { mediaId: 42 } }, ctx)
    assert.ok(Array.isArray(result.content))
    const text = result.content.find((block) => block.type === 'text')
    assert.ok(text && text.type === 'text')
    assert.deepEqual(JSON.parse(text.text), {
      ok: true,
      imageRef: 'media:42',
      mediaType: 'image',
      contentType: 'image/png',
      byteSize: 11,
      description: '一只白猫',
      descriptionStatus: 'available',
      previewIncluded: true,
    })
    assert.equal(result.content.filter((block) => block.type === 'image').length, 1)
    assert.equal(describeCalls, 0)
  })

  test('returns the preview immediately and generates a missing description in the background', async () => {
    let described = false
    const taskScheduler = createTaskScheduler({ 'media-description': { concurrency: 1 } })
    const tool = createInspectMediaTool({
      loadMediaMetadata: async () => ({
        mediaType: 'sticker',
        descriptionRaw: described ? { summary: '猫猫挥手' } : null,
      }),
      describeMedia: async () => { described = true },
      resolveImage: async () => resolvedImage,
      compress: async () => compressed,
      taskScheduler,
    })

    const result = await tool.execute({ image: { mediaId: 7 } }, ctx)
    assert.ok(Array.isArray(result.content))
    const text = result.content.find((block) => block.type === 'text')
    assert.ok(text && text.type === 'text')
    assert.equal(JSON.parse(text.text).description, null)
    assert.equal(JSON.parse(text.text).descriptionStatus, 'pending')
    await taskScheduler.drain()
    assert.equal(described, true)
  })

  test('still returns the image block while background description generation later fails', async () => {
    const taskScheduler = createTaskScheduler({ 'media-description': { concurrency: 1 } })
    const tool = createInspectMediaTool({
      loadMediaMetadata: async () => ({ mediaType: 'image', descriptionRaw: null }),
      describeMedia: async () => { throw new Error('vision unavailable') },
      resolveImage: async () => resolvedImage,
      compress: async () => compressed,
      taskScheduler,
    })

    const result = await tool.execute({ image: { mediaId: 9 } }, ctx)
    assert.ok(Array.isArray(result.content))
    const text = result.content.find((block) => block.type === 'text')
    assert.ok(text && text.type === 'text')
    const payload = JSON.parse(text.text) as { descriptionStatus: string }
    assert.equal(payload.descriptionStatus, 'pending')
    assert.equal(result.content.some((block) => block.type === 'image'), true)
    await taskScheduler.drain()
  })

  test('rejects non-image media handles', async () => {
    const tool = createInspectMediaTool({
      loadMediaMetadata: async () => ({ mediaType: 'video', descriptionRaw: null }),
    })

    const result = await tool.execute({ image: { mediaId: 3 } }, ctx)
    assert.equal(Array.isArray(result.content), false)
    assert.equal(JSON.parse(result.content as string).code, 'unsupported_media_type')
  })
})
