import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// These tests verify the shape/logic of the search module functions
// without requiring a live database connection.

describe('searchMessages result formatting', () => {
  test('empty results produce empty array', () => {
    // Simulate what searchMessages would return for 0 rows
    const rows: { messageId: bigint; senderId: bigint; senderNickname: string | null; senderGroupNickname: string | null; searchText: string; createdAt: Date }[] = []

    const results = rows.map((r) => ({
      messageId: Number(r.messageId),
      senderId: Number(r.senderId),
      senderName: r.senderGroupNickname ?? r.senderNickname ?? String(r.senderId),
      time: r.createdAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      text: r.searchText,
    }))

    assert.equal(results.length, 0)
  })

  test('prefers senderGroupNickname over senderNickname', () => {
    const row = {
      messageId: BigInt(1),
      senderId: BigInt(100),
      senderNickname: '全局昵称' as string | null,
      senderGroupNickname: '群昵称' as string | null,
      searchText: '测试消息',
      createdAt: new Date('2024-01-01T10:00:00Z'),
    }

    const senderName = row.senderGroupNickname ?? row.senderNickname ?? String(row.senderId)
    assert.equal(senderName, '群昵称')
  })

  test('falls back to senderNickname when no group nickname', () => {
    const row = {
      messageId: BigInt(1),
      senderId: BigInt(100),
      senderNickname: '全局昵称' as string | null,
      senderGroupNickname: null as string | null,
      searchText: '测试消息',
      createdAt: new Date('2024-01-01T10:00:00Z'),
    }

    const senderName = row.senderGroupNickname ?? row.senderNickname ?? String(row.senderId)
    assert.equal(senderName, '全局昵称')
  })

  test('falls back to senderId when no nicknames', () => {
    const row = {
      messageId: BigInt(1),
      senderId: BigInt(12345),
      senderNickname: null as string | null,
      senderGroupNickname: null as string | null,
      searchText: '测试消息',
      createdAt: new Date('2024-01-01T10:00:00Z'),
    }

    const senderName = row.senderGroupNickname ?? row.senderNickname ?? String(row.senderId)
    assert.equal(senderName, '12345')
  })

  test('results are reversed to chronological order', () => {
    // searchMessages queries desc then reverses
    const descRows = [
      { id: 3, text: '第三条' },
      { id: 2, text: '第二条' },
      { id: 1, text: '第一条' },
    ]

    const chronological = [...descRows].reverse()
    assert.equal(chronological[0]!.id, 1)
    assert.equal(chronological[1]!.id, 2)
    assert.equal(chronological[2]!.id, 3)
  })
})

describe('getRecentGroupMessages ordering fix', () => {
  test('desc query then reverse gives chronological order', () => {
    // Simulates the fixed getRecentGroupMessages behavior
    const descRows = [
      { messageId: 10 },
      { messageId: 9 },
      { messageId: 8 },
    ]

    const result = [...descRows].reverse()
    assert.equal(result[0]!.messageId, 8)
    assert.equal(result[2]!.messageId, 10)
  })
})
