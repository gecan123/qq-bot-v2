import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { Prisma } from '../generated/prisma/client.js'
import { prisma } from './client.js'
import { buildMessageUpsertSql, insertMessage } from './messages.js'

describe('insertMessage update payload', () => {
  let originalExecuteRaw: typeof prisma.$executeRaw

  afterEach(() => {
    if (originalExecuteRaw) {
      prisma.$executeRaw = originalExecuteRaw
    }
  })

  test('builds SQL that lets postgres derive timestamps from unix seconds', () => {
    const sql = buildMessageUpsertSql({
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

    assert.ok(sql instanceof Prisma.Sql)
    assert.match(sql.sql, /to_timestamp\(/)
    assert.equal(sql.values.filter((value) => value === 1_710_000_000).length, 3)
  })

  test('insertMessage executes raw upsert SQL', async () => {
    let capturedSql: Prisma.Sql | undefined
    originalExecuteRaw = prisma.$executeRaw
    prisma.$executeRaw = (async (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
      if (query instanceof Prisma.Sql) {
        capturedSql = query
      } else {
        capturedSql = new Prisma.Sql(query, values)
      }
      return 1
    }) as typeof prisma.$executeRaw

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

    assert.ok(capturedSql)
    assert.match(capturedSql.sql, /ON CONFLICT/)
    assert.match(capturedSql.sql, /to_timestamp\(/)
  })
})
