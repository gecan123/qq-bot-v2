import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { Prisma } from '../generated/prisma/client.js'
import { prisma } from './client.js'
import { buildMessageUpsertReturningSql, buildMessageUpsertSql, insertMessage } from './messages.js'

describe('insertMessage update payload', () => {
  let originalExecuteRaw: typeof prisma.$executeRaw | undefined
  let originalQueryRaw: typeof prisma.$queryRaw | undefined

  afterEach(() => {
    if (originalExecuteRaw) {
      prisma.$executeRaw = originalExecuteRaw
    }
    if (originalQueryRaw) {
      prisma.$queryRaw = originalQueryRaw
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

  test('insertMessage executes raw upsert SQL and returns persisted row', async () => {
    let capturedSql: Prisma.Sql | undefined
    originalQueryRaw = prisma.$queryRaw
    prisma.$queryRaw = (async (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
      if (query instanceof Prisma.Sql) {
        capturedSql = query
      } else {
        capturedSql = new Prisma.Sql(query, values)
      }
      return [{ id: 99, createdAt: new Date('2026-04-22T00:00:00Z'), sentAt: null }]
    }) as typeof prisma.$queryRaw

    const result = await insertMessage({
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
    assert.match(capturedSql.sql, /RETURNING id/)
    assert.deepEqual(result, {
      id: 99,
      createdAt: new Date('2026-04-22T00:00:00Z'),
      sentAt: null,
    })
  })

  test('builds SQL that initializes resolved_text from the current plain text', () => {
    const sql = buildMessageUpsertSql({
      groupId: 10001,
      messageId: 20002,
      senderId: 30003,
      senderNickname: 'Alice',
      content: [{ type: 'text', content: 'hello world' }],
    })

    assert.match(sql.sql, /resolved_text/)
    assert.ok(sql.values.includes('hello world'))
  })

  test('builds SQL that returns persisted row metadata', () => {
    const sql = buildMessageUpsertReturningSql({
      groupId: 10001,
      messageId: 20002,
      senderId: 30003,
      senderNickname: 'Alice',
      content: [{ type: 'text', content: 'hello world' }],
    })

    assert.match(sql.sql, /RETURNING id, created_at AS "createdAt", sent_at AS "sentAt"/)
  })
})
