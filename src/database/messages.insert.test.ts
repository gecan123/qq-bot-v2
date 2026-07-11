import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { Prisma } from '../generated/prisma/client.js'
import { prisma } from './client.js'
import {
  buildMessageUpsertReturningSql,
  buildMessageUpsertSql,
  insertMessage,
  isGroupMessageMentioningUser,
} from './messages.js'

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

  test('builds scene-aware upsert for private messages with null groupId and peerId in sceneExternalId', () => {
    const sql = buildMessageUpsertSql({
      sceneKind: 'qq_private',
      sceneExternalId: 20,
      groupId: null,
      messageId: 20002,
      senderId: 20,
      senderNickname: 'Alice',
      content: [{ type: 'text', content: 'private hello' }],
    })

    assert.match(sql.sql, /"scene_kind"/)
    assert.match(sql.sql, /"scene_external_id"/)
    assert.match(sql.sql, /ON CONFLICT \("scene_kind", "scene_external_id", "message_id"\)/)
    assert.ok(sql.values.includes('qq_private'))
    assert.ok(sql.values.includes('20'))
    // groupId column gets the literal null sentinel (not a BigInt)
    assert.ok(sql.values.includes(null))
  })

  test('insertMessage invariant: qq_group requires non-null groupId', () => {
    assert.throws(
      () =>
        buildMessageUpsertSql({
          sceneKind: 'qq_group',
          groupId: null,
          messageId: 1,
          senderId: 1,
          senderNickname: 'x',
          content: [],
        } as unknown as Parameters<typeof buildMessageUpsertSql>[0]),
      /sceneKind=qq_group requires non-null groupId/,
    )
  })

  test('insertMessage invariant: qq_group requires sceneExternalId="" (not peerId)', () => {
    assert.throws(
      () =>
        buildMessageUpsertSql({
          sceneKind: 'qq_group',
          sceneExternalId: '999',
          groupId: 111,
          messageId: 1,
          senderId: 1,
          senderNickname: 'x',
          content: [],
        }),
      /sceneKind=qq_group requires sceneExternalId=""/,
    )
  })

  test('insertMessage invariant: qq_private requires null groupId', () => {
    assert.throws(
      () =>
        buildMessageUpsertSql({
          sceneKind: 'qq_private',
          sceneExternalId: '20',
          groupId: 111,
          messageId: 1,
          senderId: 1,
          senderNickname: 'x',
          content: [],
        }),
      /sceneKind=qq_private requires groupId=null/,
    )
  })

  test('insertMessage invariant: qq_private requires non-empty sceneExternalId (peerId)', () => {
    assert.throws(
      () =>
        buildMessageUpsertSql({
          sceneKind: 'qq_private',
          sceneExternalId: '',
          groupId: null,
          messageId: 1,
          senderId: 1,
          senderNickname: 'x',
          content: [],
        }),
      /sceneKind=qq_private requires non-empty sceneExternalId/,
    )
  })
})

describe('isGroupMessageMentioningUser', () => {
  const originalFindUnique = prisma.message.findUnique

  afterEach(() => {
    prisma.message.findUnique = originalFindUnique
  })

  test('accepts only a structured at for the target user in the requested group', async () => {
    prisma.message.findUnique = (async () => ({
      groupId: 222n,
      content: [
        { type: 'text', content: '@Luna 看看' },
        { type: 'at', targetId: '9999', targetName: 'Luna' },
      ],
    })) as never

    assert.equal(await isGroupMessageMentioningUser(222, 123, 9999), true)
    assert.equal(await isGroupMessageMentioningUser(222, 123, 8888), false)
    assert.equal(await isGroupMessageMentioningUser(333, 123, 9999), false)
  })

  test('rejects missing messages and plain-text mentions', async () => {
    prisma.message.findUnique = (async () => ({
      groupId: 222n,
      content: [{ type: 'text', content: '@Luna 看看' }],
    })) as never
    assert.equal(await isGroupMessageMentioningUser(222, 123, 9999), false)

    prisma.message.findUnique = (async () => null) as never
    assert.equal(await isGroupMessageMentioningUser(222, 123, 9999), false)
  })
})
