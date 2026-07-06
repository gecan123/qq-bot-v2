import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { BotEvent } from './event.js'
import {
  mailboxKeyForEvent,
  planMailboxDisclosures,
  renderMailboxNotification,
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

function privateEvent(input: {
  rowId: number
  peerId?: number
  text?: string
  senderNickname?: string
  sentAt?: string
}): Extract<BotEvent, { type: 'napcat_private_message' }> {
  const peerId = input.peerId ?? 9001
  return {
    type: 'napcat_private_message',
    messageRowId: input.rowId,
    peerId,
    messageId: 20_000 + input.rowId,
    senderId: peerId,
    senderNickname: input.senderNickname ?? `peer-${peerId}`,
    mentionedSelf: true,
    sentAt: new Date(input.sentAt ?? `2026-07-03T00:01:${String(input.rowId).padStart(2, '0')}Z`),
    renderedText: input.text ?? 'private secret',
  }
}

describe('mailbox disclosure planning', () => {
  test('groups every QQ message by source mailbox, including mentioned group messages', () => {
    const mentioned = groupEvent({ rowId: 1, groupId: 111, text: 'mentioned group', mentionedSelf: true })
    const firstAlice = privateEvent({ rowId: 2, peerId: 9001, text: 'SECRET_ONE' })
    const bob = privateEvent({ rowId: 3, peerId: 9002, text: 'SECRET_BOB' })
    const secondAlice = privateEvent({ rowId: 4, peerId: 9001, text: 'SECRET_TWO' })

    const result = planMailboxDisclosures([mentioned, firstAlice, bob, secondAlice], {})

    assert.deepEqual(result.disclosures, [
      { kind: 'mailbox', mailboxKey: 'qq_group:111', events: [mentioned] },
      { kind: 'mailbox', mailboxKey: 'qq_private:9001', events: [firstAlice, secondAlice] },
      { kind: 'mailbox', mailboxKey: 'qq_private:9002', events: [bob] },
    ])
    assert.deepEqual(result.cursors, {
      'qq_group:111': 1,
      'qq_private:9001': 4,
      'qq_private:9002': 3,
    })
  })

  test('groups ambient messages by source without disturbing first-source order', () => {
    const first111 = groupEvent({ rowId: 3, groupId: 111, text: 'ambient one' })
    const group222 = groupEvent({ rowId: 4, groupId: 222, text: 'ambient two' })
    const second111 = groupEvent({ rowId: 5, groupId: 111, text: 'ambient three' })

    const result = planMailboxDisclosures([first111, group222, second111], {})

    assert.equal(result.disclosures.length, 2)
    assert.deepEqual(result.disclosures[0], {
      kind: 'mailbox',
      mailboxKey: 'qq_group:111',
      events: [first111, second111],
    })
    assert.deepEqual(result.disclosures[1], {
      kind: 'mailbox',
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

    const rendered = renderMailboxNotification('qq_group:111', events)
    const payload = JSON.parse(rendered)

    assert.deepEqual(payload, {
      event: 'inbox_update',
      mailbox: 'qq_group:111',
      priority: 'normal',
      source: { type: 'group', groupId: 111, groupName: '测试群' },
      count: 2,
      firstRowId: 10,
      throughRowId: 12,
      senderCount: 2,
      timeRange: {
        from: '2026-07-03T01:02:03.000Z',
        to: '2026-07-03T01:03:04.000Z',
      },
      readArgs: { action: 'read', source: 'group', groupId: 111, afterRowId: 9 },
    })
    assert.doesNotMatch(rendered, /DO_NOT_DISCLOSE/)
  })

  test('marks a group mailbox batch high priority when any message mentions the bot', () => {
    const events = [
      groupEvent({ rowId: 13, groupId: 111, text: 'ambient' }),
      groupEvent({ rowId: 14, groupId: 111, text: 'mentioned', mentionedSelf: true }),
    ]

    const rendered = renderMailboxNotification('qq_group:111', events)
    const payload = JSON.parse(rendered)

    assert.equal(payload.priority, 'high')
    assert.deepEqual(payload.readArgs, { action: 'read', source: 'group', groupId: 111, afterRowId: 12 })
    assert.equal(payload.throughRowId, 14)
    assert.doesNotMatch(rendered, /mentioned|rowIds/)
  })

  test('renders a bounded private notification without message bodies', () => {
    const events = [
      privateEvent({ rowId: 20, peerId: 9001, text: 'SECRET_ONE', senderNickname: 'Alice' }),
      privateEvent({ rowId: 22, peerId: 9001, text: 'SECRET_TWO', senderNickname: 'Alice' }),
    ]

    const rendered = renderMailboxNotification('qq_private:9001', events)
    const payload = JSON.parse(rendered)

    assert.equal(payload.priority, 'high')
    assert.deepEqual(payload.source, { type: 'private', peerId: 9001, senderName: 'Alice' })
    assert.deepEqual(payload.readArgs, { action: 'read', source: 'private', peerId: 9001, afterRowId: 19 })
    assert.equal(payload.firstRowId, 20)
    assert.equal(payload.throughRowId, 22)
    assert.doesNotMatch(rendered, /SECRET_/)
  })

  test('returns stable source keys only for QQ message events', () => {
    assert.equal(mailboxKeyForEvent(groupEvent({ rowId: 1, groupId: 111, text: 'x' })), 'qq_group:111')
    assert.equal(mailboxKeyForEvent(privateEvent({ rowId: 2 })), 'qq_private:9001')
    assert.equal(mailboxKeyForEvent({ type: 'wake' }), null)
  })
})
