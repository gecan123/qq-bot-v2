import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from './client.js'
import { insertMessage } from './messages.js'

describe('insertMessage update payload', () => {
  let originalUpsert: typeof prisma.message.upsert

  afterEach(() => {
    if (originalUpsert) {
      ;(prisma.message as { upsert: typeof prisma.message.upsert }).upsert = originalUpsert
    }
  })

  test('upsert update should refresh content/raw/sentAt fields', async () => {
    let capturedArgs: unknown
    originalUpsert = prisma.message.upsert
    ;(prisma.message as { upsert: typeof prisma.message.upsert }).upsert = (async (args) => {
      capturedArgs = args
      return {} as any
    }) as typeof prisma.message.upsert

    await insertMessage({
      groupId: 10001,
      groupName: '测试群',
      mediaReferenceIds: ['123'],
      messageId: 20002,
      senderId: 30003,
      senderNickname: 'Alice',
      senderGroupNickname: 'Alice群名片',
      content: [{ type: 'text', content: '  hello world  ' }],
      rawContent: [{ type: 'text', data: { text: 'hello world' } }],
      rawMessage: 'hello world',
      sentAt: 1_710_000_000,
    })

    const args = capturedArgs as {
      update: Record<string, unknown>
    }

    assert.equal(args.update.groupName, '测试群')
    assert.deepEqual(args.update.mediaReferenceIds, ['123'])
    assert.equal(args.update.searchText, 'hello world')

    assert.deepEqual(args.update.content, [{ type: 'text', content: '  hello world  ' }])
    assert.deepEqual(args.update.rawContent, [{ type: 'text', data: { text: 'hello world' } }])
    assert.equal(args.update.rawMessage, 'hello world')
    assert.equal((args.update.sentAt as Date).toISOString(), '2024-03-09T16:00:00.000Z')
  })
})
