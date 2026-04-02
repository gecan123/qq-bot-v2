import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from '../database/client.js'
import { jobQueue } from '../queue/runtime.js'
import { collectReferenceIds, ensureDescriptions } from './ensure-descriptions.js'
import type { ParsedSegment } from '../types/message-segments.js'

const originalFindMany = prisma.media.findMany
const originalFindUnique = prisma.media.findUnique
const originalEnqueueAndWait = jobQueue.enqueueAndWait

afterEach(() => {
  prisma.media.findMany = originalFindMany
  prisma.media.findUnique = originalFindUnique
  jobQueue.enqueueAndWait = originalEnqueueAndWait
})

describe('collectReferenceIds', () => {
  test('returns referenceIds from image, video, record, and file segments', () => {
    const groups: ParsedSegment[][] = [
      [
        { type: 'image', referenceId: '42' },
        { type: 'text', content: 'hello' },
        { type: 'video', referenceId: '99' },
      ],
      [{ type: 'record', referenceId: '7' }],
      [{ type: 'file', referenceId: '3' }],
    ]
    assert.deepEqual(collectReferenceIds(groups), [42, 99, 7, 3])
  })

  test('ignores segments without referenceId', () => {
    const groups: ParsedSegment[][] = [
      [{ type: 'image', url: 'http://example.com/img.jpg' }],
    ]
    assert.deepEqual(collectReferenceIds(groups), [])
  })

  test('ignores non-media segments', () => {
    const groups: ParsedSegment[][] = [
      [
        { type: 'text', content: 'hello' },
        { type: 'face', faceId: 1 },
        { type: 'at', targetId: '123' },
      ],
    ]
    assert.deepEqual(collectReferenceIds(groups), [])
  })

  test('returns empty array for empty input', () => {
    assert.deepEqual(collectReferenceIds([]), [])
  })

  test('returns empty array for messages with no segments', () => {
    assert.deepEqual(collectReferenceIds([[]]), [])
  })

  test('ignores invalid referenceIds', () => {
    const groups: ParsedSegment[][] = [
      [
        { type: 'image', referenceId: 'abc' },
        { type: 'video', referenceId: '-1' },
        { type: 'record', referenceId: '0' },
        { type: 'file', referenceId: '12' },
      ],
    ]
    assert.deepEqual(collectReferenceIds(groups), [12])
  })
})

describe('ensureDescriptions', () => {
  test('enqueues pending media descriptions through the shared high-priority queue', async () => {
    const calls: Array<{ type: string; data: { mediaId: number }; options: { priority: string } | undefined }> = []

    prisma.media.findMany = (async () => [{ mediaId: 42 }, { mediaId: 99 }]) as unknown as typeof prisma.media.findMany
    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('image-bytes')),
      contentType: 'image/jpeg',
      mediaType: 'image',
      description: null,
      fileName: 'test.jpg',
    })) as unknown as typeof prisma.media.findUnique

    jobQueue.enqueueAndWait = (async (type: string, data: { mediaId: number }, options?: { priority?: string }) => {
      calls.push({ type, data, options: options ? { priority: options.priority ?? 'normal' } : undefined })
    }) as typeof jobQueue.enqueueAndWait

    await ensureDescriptions(
      [
        {
          content: [
            { type: 'image', referenceId: '42' },
            { type: 'video', referenceId: '99' },
          ],
        } as any,
      ],
      100,
    )

    assert.deepEqual(calls, [
      { type: 'generate-description', data: { mediaId: 42 }, options: { priority: 'high' } },
      { type: 'generate-description', data: { mediaId: 99 }, options: { priority: 'high' } },
    ])
  })
})
