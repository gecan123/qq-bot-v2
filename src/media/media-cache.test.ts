import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from '../database/client.js'
import { jobQueue } from '../queue/runtime.js'
import { persistMediaReferences, waitForPendingMediaDownloads } from './media-cache.js'

const originalCreate = prisma.media.create
const originalFindUnique = prisma.media.findUnique
const originalUpdate = prisma.media.update
const originalEnqueue = jobQueue.enqueue
const originalFetch = globalThis.fetch

afterEach(() => {
  prisma.media.create = originalCreate
  prisma.media.findUnique = originalFindUnique
  prisma.media.update = originalUpdate
  jobQueue.enqueue = originalEnqueue
  globalThis.fetch = originalFetch
})

describe('persistMediaReferences', () => {
  test('returns a stable media reference before the media download finishes', async () => {
    const updates: unknown[] = []
    const enqueued: unknown[] = []
    let releaseFetch!: () => void
    const fetchBlocker = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })

    prisma.media.create = (async (args: unknown) => {
      assert.deepEqual((args as { data: { data: Uint8Array } }).data.data, new Uint8Array(0))
      return { mediaId: 42 }
    }) as typeof prisma.media.create
    prisma.media.findUnique = (async () => null) as typeof prisma.media.findUnique
    prisma.media.update = (async (args: unknown) => {
      updates.push(args)
      return { mediaId: 42 }
    }) as typeof prisma.media.update
    jobQueue.enqueue = ((type: string, data: unknown, options?: unknown) => {
      enqueued.push({ type, data, options })
    }) as typeof jobQueue.enqueue
    globalThis.fetch = (async () => {
      await fetchBlocker
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }) as typeof fetch

    const result = await Promise.race([
      persistMediaReferences({
        content: [{ type: 'image', url: 'https://example.test/a.png', fileName: 'a.png' }],
        scope: { kind: 'group', groupId: 1 },
        messageId: 100,
        senderId: 200,
        napcat: {} as never,
      }),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 20)),
    ])

    assert.notEqual(result, 'timed-out')
    assert.deepEqual(result, {
      content: [{ type: 'image', fileName: 'a.png', referenceId: '42', url: undefined }],
      mediaReferenceIds: ['42'],
    })
    assert.deepEqual(updates, [])

    releaseFetch()
    await waitForPendingMediaDownloads([42], 1000)

    assert.equal(updates.length, 1)
    assert.deepEqual(enqueued, [
      {
        type: 'generate-description',
        data: { mediaId: 42 },
        options: { priority: 'low' },
      },
    ])
  })

  test('persists media nested inside a forwarded child message', async () => {
    prisma.media.create = (async () => ({ mediaId: 42 })) as unknown as typeof prisma.media.create

    const result = await persistMediaReferences({
      content: [{
        type: 'forward',
        forwardId: 'forward-1',
        items: [{
          messageId: '11',
          senderId: '101',
          content: [{
            type: 'image',
            url: 'https://example.test/nested.png',
            fileName: 'nested.png',
            fileSize: String(21 * 1024 * 1024),
          }],
        }],
      }],
      scope: { kind: 'group', groupId: 1 },
      messageId: 100,
      senderId: 200,
      napcat: {} as never,
    })

    assert.deepEqual(result, {
      content: [{
        type: 'forward',
        forwardId: 'forward-1',
        items: [{
          messageId: '11',
          senderId: '101',
          content: [{
            type: 'image',
            fileName: 'nested.png',
            fileSize: String(21 * 1024 * 1024),
            referenceId: '42',
            url: undefined,
          }],
        }],
      }],
      mediaReferenceIds: ['42'],
    })
  })
})
