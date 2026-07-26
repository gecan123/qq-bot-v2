import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { promoteToMedia } from './promote-outbound.js'

describe('promoteToMedia', () => {
  test('creates a Media handle backed by content-addressed bytes', async () => {
    let capturedArgs: unknown
    const createMedia = async (args: Parameters<NonNullable<Parameters<typeof promoteToMedia>[1]>>[0]) => {
      capturedArgs = args
      return 42
    }

    const result = await promoteToMedia({
      bytes: Buffer.from('hello'),
      dataHash: 'a'.repeat(64),
      contentType: 'image/png',
      description: 'test description',
    }, createMedia)

    assert.equal(result, 42)
    const args = capturedArgs as {
      bytes: Buffer
      dataHash: string
      contentType: string
      mediaType: string
      descriptionRaw: unknown
    }
    assert.equal(args.dataHash, 'a'.repeat(64))
    assert.equal(args.contentType, 'image/png')
    assert.equal(args.mediaType, 'image')
    assert.deepEqual(args.descriptionRaw, { description: 'test description', source: 'outbound' })
    assert.deepEqual(args.bytes, Buffer.from('hello'))
  })

  test('prisma error propagates to caller', async () => {
    const createMedia = async () => {
      throw new Error('connection refused')
    }

    await assert.rejects(
      () => promoteToMedia({
        bytes: Buffer.from('test'),
        dataHash: 'c'.repeat(64),
        contentType: 'image/png',
        description: 'fail',
      }, createMedia),
      /connection refused/,
    )
  })

  test('custom mediaType is passed through', async () => {
    let capturedArgs: Record<string, unknown> | undefined
    const createMedia = async (args: Record<string, unknown>) => {
      capturedArgs = args
      return 99
    }

    await promoteToMedia({
      bytes: Buffer.from('sticker'),
      dataHash: 'd'.repeat(64),
      contentType: 'image/webp',
      description: 'a sticker',
      mediaType: 'sticker',
    }, createMedia as never)

    assert.equal(capturedArgs?.mediaType, 'sticker')
  })
})
