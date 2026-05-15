import assert from 'node:assert/strict'
import { describe, test, beforeEach, afterEach } from 'node:test'
import { prisma } from '../database/client.js'
import { promoteToMedia } from './promote-outbound.js'

describe('promoteToMedia', () => {
  let originalUpsert: typeof prisma.media.upsert

  beforeEach(() => {
    originalUpsert = prisma.media.upsert
  })

  afterEach(() => {
    prisma.media.upsert = originalUpsert
  })

  test('upserts with correct fields and returns mediaId', async () => {
    let capturedArgs: unknown
    prisma.media.upsert = (async (args: unknown) => {
      capturedArgs = args
      return { mediaId: 42 }
    }) as never

    const result = await promoteToMedia({
      bytes: Buffer.from('hello'),
      dataHash: 'a'.repeat(64),
      contentType: 'image/png',
      description: 'test description',
    })

    assert.equal(result, 42)
    const args = capturedArgs as Record<string, Record<string, unknown>>
    assert.deepEqual(args.where, { dataHash: 'a'.repeat(64) })
    assert.equal(args.create.dataHash, 'a'.repeat(64))
    assert.equal(args.create.contentType, 'image/png')
    assert.equal(args.create.mediaType, 'image')
    assert.equal(args.create.fileSize, 5)
    assert.deepEqual(args.create.descriptionRaw, { description: 'test description', source: 'outbound' })
    assert.deepEqual(args.update, {})
    assert.deepEqual(args.select, { mediaId: true })
    const dataBytes = args.create.data as Uint8Array
    assert.deepEqual(Buffer.from(dataBytes), Buffer.from('hello'))
  })

  test('same dataHash upsert returns existing mediaId (dedup)', async () => {
    prisma.media.upsert = (async () => ({ mediaId: 7 })) as never

    const first = await promoteToMedia({
      bytes: Buffer.from('img1'),
      dataHash: 'b'.repeat(64),
      contentType: 'image/jpeg',
      description: 'dup',
    })
    const second = await promoteToMedia({
      bytes: Buffer.from('img1'),
      dataHash: 'b'.repeat(64),
      contentType: 'image/jpeg',
      description: 'dup',
    })

    assert.equal(first, 7)
    assert.equal(second, 7)
  })

  test('prisma error propagates to caller', async () => {
    prisma.media.upsert = (async () => {
      throw new Error('connection refused')
    }) as never

    await assert.rejects(
      () => promoteToMedia({
        bytes: Buffer.from('test'),
        dataHash: 'c'.repeat(64),
        contentType: 'image/png',
        description: 'fail',
      }),
      /connection refused/,
    )
  })

  test('custom mediaType is passed through', async () => {
    let capturedArgs: Record<string, unknown> | undefined
    prisma.media.upsert = (async (args: unknown) => {
      capturedArgs = args as Record<string, unknown>
      return { mediaId: 99 }
    }) as never

    await promoteToMedia({
      bytes: Buffer.from('sticker'),
      dataHash: 'd'.repeat(64),
      contentType: 'image/webp',
      description: 'a sticker',
      mediaType: 'sticker',
    })

    const create = (capturedArgs as Record<string, Record<string, unknown>>).create
    assert.equal(create.mediaType, 'sticker')
  })
})
