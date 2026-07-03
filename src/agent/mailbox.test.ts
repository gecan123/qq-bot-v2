import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { BotEvent } from './event.js'
import {
  mailboxKeyForEvent,
  planMailboxDisclosures,
  renderAmbientMailboxNotification,
} from './mailbox.js'

function groupEvent(input: {
  rowId: number
  groupId: number
  text: string
  mentionedSelf?: boolean
  senderId?: number
  sentAt?: string
}): Extract<BotEvent, { type: 'napcat_message' }> {
  return {
    type: 'napcat_message',
    messageRowId: input.rowId,
    groupId: input.groupId,
    groupName: input.groupId === 111 ? '测试群' : undefined,
    messageId: 10_000 + input.rowId,
    senderId: input.senderId ?? input.rowId,
    senderNickname: `user-${input.rowId}`,
    mentionedSelf: input.mentionedSelf ?? false,
    sentAt: new Date(input.sentAt ?? `2026-07-03T00:00:${String(input.rowId).padStart(2, '0')}Z`),
    renderedText: input.text,
  }
}

function privateEvent(rowId: number): Extract<BotEvent, { type: 'napcat_private_message' }> {
  return {
    type: 'napcat_private_message',
    messageRowId: rowId,
    peerId: 9001,
    messageId: 20_000 + rowId,
    senderId: 9001,
    senderNickname: 'Alice',
    mentionedSelf: true,
    sentAt: new Date(`2026-07-03T00:01:${String(rowId).padStart(2, '0')}Z`),
    renderedText: 'private secret',
  }
}

describe('mailbox disclosure planning', () => {
  test('keeps private and mentioned group messages as direct disclosures', () => {
    const mentioned = groupEvent({ rowId: 1, groupId: 111, text: 'direct group', mentionedSelf: true })
    const directPrivate = privateEvent(2)

    const result = planMailboxDisclosures([mentioned, directPrivate], {})

    assert.deepEqual(result.disclosures, [
      { kind: 'direct', event: mentioned },
      { kind: 'direct', event: directPrivate },
    ])
    assert.deepEqual(result.cursors, {
      'qq_group:111': 1,
      'qq_private:9001': 2,
    })
  })

  test('groups ambient messages by source without disturbing first-source order', () => {
    const first111 = groupEvent({ rowId: 3, groupId: 111, text: 'ambient one' })
    const group222 = groupEvent({ rowId: 4, groupId: 222, text: 'ambient two' })
    const second111 = groupEvent({ rowId: 5, groupId: 111, text: 'ambient three' })

    const result = planMailboxDisclosures([first111, group222, second111], {})

    assert.equal(result.disclosures.length, 2)
    assert.deepEqual(result.disclosures[0], {
      kind: 'ambient',
      mailboxKey: 'qq_group:111',
      events: [first111, second111],
    })
    assert.deepEqual(result.disclosures[1], {
      kind: 'ambient',
      mailboxKey: 'qq_group:222',
      events: [group222],
    })
  })

  test('advances each cursor monotonically and preserves unseen sources', () => {
    const result = planMailboxDisclosures([
      groupEvent({ rowId: 8, groupId: 111, text: 'new' }),
      groupEvent({ rowId: 6, groupId: 111, text: 'late' }),
    ], {
      'qq_group:111': 7,
      'qq_group:333': 99,
    })

    assert.deepEqual(result.cursors, {
      'qq_group:111': 8,
      'qq_group:333': 99,
    })
  })

  test('renders a bounded metadata notification without ambient message bodies', () => {
    const events = [
      groupEvent({ rowId: 10, groupId: 111, text: 'DO_NOT_DISCLOSE_ONE', senderId: 1, sentAt: '2026-07-03T01:02:03Z' }),
      groupEvent({ rowId: 12, groupId: 111, text: 'DO_NOT_DISCLOSE_TWO', senderId: 2, sentAt: '2026-07-03T01:03:04Z' }),
    ]

    const rendered = renderAmbientMailboxNotification('qq_group:111', events)

    assert.match(rendered, /^\[inbox 更新 \| 群:测试群 \| mailbox=qq_group:111\]/)
    assert.match(rendered, /新增 2 条/)
    assert.match(rendered, /rowId 10\.\.12/)
    assert.match(rendered, /发送者 2 人/)
    assert.match(rendered, /inbox action=read groupId=111 afterRowId=9/)
    assert.doesNotMatch(rendered, /DO_NOT_DISCLOSE/)
  })

  test('returns stable source keys only for QQ message events', () => {
    assert.equal(mailboxKeyForEvent(groupEvent({ rowId: 1, groupId: 111, text: 'x' })), 'qq_group:111')
    assert.equal(mailboxKeyForEvent(privateEvent(2)), 'qq_private:9001')
    assert.equal(mailboxKeyForEvent({ type: 'wake' }), null)
  })
})
