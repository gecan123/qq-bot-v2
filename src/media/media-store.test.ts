import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from '../database/client.js'
import { attachMediaBlob, createMediaFromBytes } from './media-store.js'

const originalTransaction = prisma.$transaction

afterEach(() => {
  prisma.$transaction = originalTransaction
})

describe('media blob store', () => {
  test('two media rows with the same hash share one physical blob and keep their own metadata', async () => {
    const blobs = new Map<string, { blobId: number; byteSize: number; data: Uint8Array }>()
    const updates: unknown[] = []
    let nextBlobId = 1
    const tx = {
      mediaBlob: {
        async upsert(args: {
          where: { dataHash: string }
          create: { data: Uint8Array; byteSize: number }
        }) {
          const existing = blobs.get(args.where.dataHash)
          if (existing) return existing
          const created = {
            blobId: nextBlobId++,
            byteSize: args.create.byteSize,
            data: args.create.data,
          }
          blobs.set(args.where.dataHash, created)
          return created
        },
      },
      media: {
        async update(args: unknown) {
          updates.push(args)
          return {}
        },
      },
    }
    prisma.$transaction = (async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) as never

    const bytes = Buffer.from('same image')
    const dataHash = 'a'.repeat(64)
    const firstBlobId = await attachMediaBlob({
      mediaId: 1,
      bytes,
      dataHash,
      mediaType: 'image',
      contentType: 'image/png',
      fileName: 'first.png',
      fileSize: bytes.byteLength,
    })
    const secondBlobId = await attachMediaBlob({
      mediaId: 2,
      bytes,
      dataHash,
      mediaType: 'sticker',
      contentType: 'image/png',
      fileName: 'second.png',
      fileSize: bytes.byteLength,
    })

    assert.equal(blobs.size, 1)
    assert.equal(firstBlobId, secondBlobId)
    assert.deepEqual(
      updates.map((value) => (value as { data: unknown }).data),
      [
        {
          blobId: 1,
          mediaType: 'image',
          contentType: 'image/png',
          fileName: 'first.png',
          fileSize: bytes.byteLength,
        },
        {
          blobId: 1,
          mediaType: 'sticker',
          contentType: 'image/png',
          fileName: 'second.png',
          fileSize: bytes.byteLength,
        },
      ],
    )
  })

  test('creating two durable handles shares bytes but returns distinct media ids', async () => {
    let mediaId = 0
    let blobCreates = 0
    const tx = {
      mediaBlob: {
        async upsert() {
          blobCreates++
          return { blobId: 7, byteSize: 4 }
        },
      },
      media: {
        async create() {
          return { mediaId: ++mediaId }
        },
      },
    }
    prisma.$transaction = (async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) as never

    const input = {
      bytes: Buffer.from('same'),
      dataHash: 'b'.repeat(64),
      mediaType: 'image',
      contentType: 'image/png',
    }
    assert.equal(await createMediaFromBytes(input), 1)
    assert.equal(await createMediaFromBytes(input), 2)
    assert.equal(blobCreates, 2, '每次调用 upsert，但数据库唯一约束只保留一个 blob')
  })

  test('rejects a hash hit with a different byte size', async () => {
    const tx = {
      mediaBlob: {
        async upsert() {
          return { blobId: 7, byteSize: 99 }
        },
      },
      media: {
        async update() {
          throw new Error('must not attach a mismatched blob')
        },
      },
    }
    prisma.$transaction = (async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) as never

    await assert.rejects(
      attachMediaBlob({
        mediaId: 1,
        bytes: Buffer.from('short'),
        dataHash: 'c'.repeat(64),
        mediaType: 'image',
        fileSize: 5,
      }),
      /media_blob_hash_collision_or_corruption/,
    )
  })
})
