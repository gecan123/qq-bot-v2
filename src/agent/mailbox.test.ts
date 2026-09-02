import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { BotEvent } from './event.js'
import {
  MAILBOX_BACKLOG_RECENT_LIMIT,
  MAILBOX_BACKLOG_THRESHOLD,
  isMailboxKey,
  mailboxKeyForEvent,
  planMailboxDisclosures,
  renderMailboxBacklogNotification,
  renderMailboxDeltaBatch,
  renderMailboxNotification,
} from './mailbox.js'

describe('mailbox key contract', () => {
  test('recognizes canonical encoded and legacy QQ keys from one parser', () => {
    for (const key of [
      'qq_group:1',
      'qq_private:2',
      'qq:bot:group:123',
      'feishu:app:private:ou_1',
      'feishu:app%3Atenant:group:oc%3A1',
    ]) {
      assert.equal(isMailboxKey(key), true, key)
    }
    for (const key of ['', 'qq_group:x', 'qq::group:1', 'qq:bot:unknown:1', 'qq:bot:group:1:2']) {
      assert.equal(isMailboxKey(key), false, key)
    }
  })
})

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

function platformEvent(input: {
  rowId: number
  platform: 'qq' | 'feishu'
  accountId: string
  conversationId: string
  eventKind?: 'message' | 'edit' | 'recall'
}): Extract<BotEvent, { type: 'chat_message' }> {
  return {
    type: 'chat_message',
    eventKind: input.eventKind ?? 'message',
    messageRowId: input.rowId,
    conversation: {
      platform: input.platform,
      accountId: input.accountId,
      kind: 'group',
      externalId: input.conversationId,
    },
    messageExternalId: `message-${input.rowId}`,
    senderExternalId: `sender-${input.rowId}`,
    senderName: `sender-${input.rowId}`,
    mentionedSelf: false,
    sentAt: new Date(`2026-07-03T00:02:${String(input.rowId).padStart(2, '0')}Z`),
    renderedText: `body-${input.rowId}`,
  }
}

describe('mailbox disclosure planning', () => {
  test('renders several live group mailboxes as one compact deterministic delta', () => {
    const first = platformEvent({
      rowId: 11,
      platform: 'qq',
      accountId: 'bot',
      conversationId: '111',
    })
    const second = platformEvent({
      rowId: 12,
      platform: 'qq',
      accountId: 'bot',
      conversationId: '222',
    })
    second.mentionedSelf = true

    const content = renderMailboxDeltaBatch([
      { kind: 'mailbox', mailboxKey: 'qq:bot:group:111', events: [first] },
      { kind: 'mailbox', mailboxKey: 'qq:bot:group:222', events: [second] },
    ])
    assert.notEqual(content, null)
    const payload = JSON.parse(content!)

    assert.equal(payload.event, 'conversation_deltas')
    assert.deepEqual(payload.mailboxes.map((item: Record<string, unknown>) => item.mailbox), [
      'qq:bot:group:111',
      'qq:bot:group:222',
    ])
    assert.deepEqual(payload.mailboxes[0].messages, [{
      rowId: 11,
      sentAt: '2026-07-03T08:02+08:00',
      senderExternalId: 'sender-11',
      senderName: 'sender-11',
      text: 'body-11',
    }])
    assert.equal(payload.mailboxes[1].priority, 'high')
    assert.equal(payload.mailboxes[1].messages[0].mentionedSelf, true)
    assert.doesNotMatch(JSON.stringify(payload), /replyToExternalId|null|tool|readArgs/)
  })

  test('rejects an oversized live delta so the caller can keep it in inbox', () => {
    const events = Array.from({ length: 20 }, (_, index) => groupEvent({
      rowId: index + 1,
      groupId: 111,
      text: `body-${index}-${'x'.repeat(2_000)}`,
    }))

    assert.equal(renderMailboxDeltaBatch([
      { kind: 'mailbox', mailboxKey: 'qq_group:111', events },
    ]), null)
  })

  test('isolates conversations by platform and account while preserving local row order', () => {
    const qq = platformEvent({ rowId: 1, platform: 'qq', accountId: '10000', conversationId: 'shared' })
    const feishu = platformEvent({ rowId: 2, platform: 'feishu', accountId: 'cli_1', conversationId: 'shared' })
    const qqAgain = platformEvent({ rowId: 3, platform: 'qq', accountId: '10000', conversationId: 'shared' })

    const result = planMailboxDisclosures([qq, feishu, qqAgain], {})

    assert.deepEqual(result.disclosures, [
      { kind: 'mailbox', mailboxKey: 'qq:10000:group:shared', events: [qq, qqAgain] },
      { kind: 'mailbox', mailboxKey: 'feishu:cli_1:group:shared', events: [feishu] },
    ])
    assert.deepEqual(result.cursors, {
      'qq:10000:group:shared': 3,
      'feishu:cli_1:group:shared': 2,
    })
  })

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
      event: 'notification',
      id: 'qq:qq_group:111:12',
      source: { type: 'qq', mailbox: 'qq_group:111' },
      kind: 'inbox_update',
      priority: 'normal',
      delivery: 'passive',
      groupKey: 'qq_group:111',
      count: 2,
      open: {
        tool: 'inbox',
        args: { action: 'read', source: 'group', groupId: 111, afterRowId: 9 },
      },
      data: {
        mailbox: 'qq_group:111',
        qqSource: { type: 'group', groupId: 111, groupName: '测试群' },
        firstRowId: 10,
        throughRowId: 12,
        senderCount: 2,
        timeRange: {
          from: '2026-07-03T09:02+08:00',
          to: '2026-07-03T09:03+08:00',
        },
        readArgs: { action: 'read', source: 'group', groupId: 111, afterRowId: 9 },
      },
    })
    assert.doesNotMatch(rendered, /DO_NOT_DISCLOSE/)
  })

  test('renders one minute-level time anchor for a single message', () => {
    const rendered = renderMailboxNotification('qq_group:111', [
      groupEvent({
        rowId: 10,
        groupId: 111,
        text: 'DO_NOT_DISCLOSE',
        sentAt: '2026-07-03T01:02:59.999Z',
      }),
    ])
    const payload = JSON.parse(rendered)

    assert.equal(payload.occurredAt, '2026-07-03T09:02+08:00')
    assert.equal(payload.data.timeRange, undefined)
    assert.equal((rendered.match(/2026-07-03T09:02\+08:00/g) ?? []).length, 1)
  })

  test('marks a group mailbox batch high priority when any message mentions the bot', () => {
    const events = [
      groupEvent({ rowId: 13, groupId: 111, text: 'ambient' }),
      groupEvent({ rowId: 14, groupId: 111, text: 'mentioned', mentionedSelf: true }),
    ]

    const rendered = renderMailboxNotification('qq_group:111', events)
    const payload = JSON.parse(rendered)

    assert.equal(payload.priority, 'high')
    assert.equal(payload.delivery, 'interrupt')
    assert.deepEqual(payload.open, {
      tool: 'inbox',
      args: { action: 'read', source: 'group', groupId: 111, afterRowId: 12 },
    })
    assert.equal(payload.data.throughRowId, 14)
    assert.doesNotMatch(rendered, /mentioned|rowIds/)
  })

  test('marks lifecycle corrections high priority even without a group mention', () => {
    const edited = platformEvent({
      rowId: 15,
      platform: 'feishu',
      accountId: 'cli_1',
      conversationId: 'oc_1',
      eventKind: 'edit',
    })

    const payload = JSON.parse(renderMailboxNotification('feishu:cli_1:group:oc_1', [edited]))

    assert.equal(payload.priority, 'high')
    assert.equal(payload.delivery, 'interrupt')
  })

  test('discloses configured group participation without exposing message bodies', () => {
    const events = [
      groupEvent({ rowId: 15, groupId: 111, text: 'DO_NOT_DISCLOSE_CHATTY_BODY' }),
    ]

    const rendered = renderMailboxNotification('qq_group:111', events, {
      participation: 'active',
    })
    const payload = JSON.parse(rendered)

    assert.equal(payload.data.participation, 'active')
    assert.doesNotMatch(rendered, /DO_NOT_DISCLOSE_CHATTY_BODY/)
  })

  test('keeps large live batches on the exact unread range', () => {
    const events = Array.from({ length: MAILBOX_BACKLOG_THRESHOLD + 1 }, (_, index) =>
      groupEvent({
        rowId: 1_000 + index * 3,
        groupId: 111,
        text: `body-${index}`,
        senderId: index % 10,
        sentAt: `2026-07-03T01:${String(index % 60).padStart(2, '0')}:00Z`,
      }))

    const rendered = renderMailboxNotification('qq_group:111', events)
    const payload = JSON.parse(rendered)
    assert.equal(payload.data.mode, undefined)
    assert.equal(payload.count, MAILBOX_BACKLOG_THRESHOLD + 1)
    assert.deepEqual(payload.data.readArgs, { action: 'read', source: 'group', groupId: 111, afterRowId: 999 })
    assert.equal(payload.data.latestReadArgs, undefined)
    assert.equal(payload.data.throughRowId, events.at(-1)!.messageRowId)
    assert.deepEqual(payload.open, { tool: 'inbox', args: payload.data.readArgs })
    assert.doesNotMatch(rendered, /body-/)
  })

  test('plans backlog events as cursor-advancing metadata disclosures', () => {
    const backlog: Extract<BotEvent, { type: 'mailbox_backlog' }> = {
      type: 'mailbox_backlog',
      mailboxKey: 'qq_group:111',
      priority: 'normal',
      source: { type: 'group', groupId: 111, groupName: '测试群' },
      count: 230,
      firstRowId: 1_000,
      throughRowId: 1_500,
      recentAfterRowId: 1_430,
      senderCount: 12,
      timeRange: {
        from: new Date('2026-07-03T01:00:00Z'),
        to: new Date('2026-07-03T02:00:00Z'),
      },
    }

    const result = planMailboxDisclosures([backlog], {})

    assert.deepEqual(result.disclosures, [{ kind: 'backlog', event: backlog }])
    assert.deepEqual(result.cursors, { 'qq_group:111': 1_500 })
  })

  test('renders replay backlog notifications without message bodies', () => {
    const rendered = renderMailboxBacklogNotification({
      type: 'mailbox_backlog',
      mailboxKey: 'qq_private:9001',
      priority: 'high',
      source: { type: 'private', peerId: 9001, senderName: 'Alice' },
      count: 150,
      firstRowId: 20,
      throughRowId: 220,
      recentAfterRowId: 170,
      senderCount: 1,
      timeRange: {
        from: new Date('2026-07-03T01:00:00Z'),
        to: new Date('2026-07-03T02:00:00Z'),
      },
    })
    const payload = JSON.parse(rendered)

    assert.equal(payload.data.mode, 'backlog')
    assert.equal(payload.occurredAt, undefined)
    assert.deepEqual(payload.data.timeRange, {
      from: '2026-07-03T09:00+08:00',
      to: '2026-07-03T10:00+08:00',
    })
    assert.deepEqual(payload.data.readArgs, { action: 'read', source: 'private', peerId: 9001, afterRowId: 19 })
    assert.deepEqual(payload.data.latestReadArgs, {
      action: 'read',
      source: 'private',
      peerId: 9001,
      afterRowId: 170,
      limit: MAILBOX_BACKLOG_RECENT_LIMIT,
    })
    assert.deepEqual(payload.open, { tool: 'inbox', args: payload.data.readArgs })
    assert.doesNotMatch(rendered, /Alice.+SECRET|SECRET/)
  })

  test('keeps a Feishu replay backlog platform scoped', () => {
    const conversation = {
      platform: 'feishu' as const,
      accountId: 'cli_1',
      kind: 'group' as const,
      externalId: 'oc_1',
    }
    const rendered = renderMailboxBacklogNotification({
      type: 'mailbox_backlog',
      mailboxKey: 'feishu:cli_1:group:oc_1',
      priority: 'normal',
      source: { type: 'conversation', conversation, name: '飞书群', senderName: 'Alice' },
      count: 150,
      firstRowId: 20,
      throughRowId: 220,
      recentAfterRowId: 170,
      senderCount: 10,
      timeRange: {
        from: new Date('2026-07-03T01:00:00Z'),
        to: new Date('2026-07-03T02:00:00Z'),
      },
    })
    const payload = JSON.parse(rendered)

    assert.equal(payload.id, 'feishu:feishu:cli_1:group:oc_1:220')
    assert.deepEqual(payload.source, { type: 'feishu', mailbox: 'feishu:cli_1:group:oc_1' })
    assert.deepEqual(payload.data.conversation, { ...conversation, name: '飞书群' })
    assert.equal(payload.data.qqSource, undefined)
    assert.deepEqual(payload.open, { tool: 'inbox', args: payload.data.latestReadArgs })
  })

  test('discloses configured group participation for replay backlog notifications', () => {
    const rendered = renderMailboxBacklogNotification({
      type: 'mailbox_backlog',
      mailboxKey: 'qq_group:111',
      priority: 'normal',
      source: { type: 'group', groupId: 111, groupName: '测试群' },
      count: 150,
      firstRowId: 20,
      throughRowId: 220,
      recentAfterRowId: 170,
      senderCount: 12,
      timeRange: {
        from: new Date('2026-07-03T01:00:00Z'),
        to: new Date('2026-07-03T02:00:00Z'),
      },
    }, { participation: 'mentions' })

    assert.equal(JSON.parse(rendered).data.participation, 'mentions')
  })

  test('renders a bounded private notification without message bodies', () => {
    const events = [
      privateEvent({ rowId: 20, peerId: 9001, text: 'SECRET_ONE', senderNickname: 'Alice' }),
      privateEvent({ rowId: 22, peerId: 9001, text: 'SECRET_TWO', senderNickname: 'Alice' }),
    ]

    const rendered = renderMailboxNotification('qq_private:9001', events)
    const payload = JSON.parse(rendered)

    assert.equal(payload.priority, 'high')
    assert.equal(payload.delivery, 'interrupt')
    assert.deepEqual(payload.data.qqSource, { type: 'private', peerId: 9001, senderName: 'Alice' })
    assert.deepEqual(payload.open, {
      tool: 'inbox',
      args: { action: 'read', source: 'private', peerId: 9001, afterRowId: 19 },
    })
    assert.equal(payload.data.firstRowId, 20)
    assert.equal(payload.data.throughRowId, 22)
    assert.doesNotMatch(rendered, /SECRET_/)
  })

  test('adds bounded same-mailbox compensation to notification read args', () => {
    const events = [
      privateEvent({ rowId: 30, peerId: 9001, text: 'CURRENT', senderNickname: 'Alice' }),
    ]

    const rendered = renderMailboxNotification('qq_private:9001', events, { contextBefore: 8 })
    const payload = JSON.parse(rendered)

    assert.deepEqual(payload.open, {
      tool: 'inbox',
      args: {
      action: 'read',
      source: 'private',
      peerId: 9001,
      afterRowId: 29,
      contextBefore: 8,
      },
    })
    assert.doesNotMatch(rendered, /CURRENT/)
  })

  test('returns stable source keys only for QQ message events', () => {
    assert.equal(mailboxKeyForEvent(groupEvent({ rowId: 1, groupId: 111, text: 'x' })), 'qq_group:111')
    assert.equal(mailboxKeyForEvent(privateEvent({ rowId: 2 })), 'qq_private:9001')
    assert.equal(mailboxKeyForEvent({
      type: 'mailbox_backlog',
      mailboxKey: 'qq_group:111',
      priority: 'normal',
      source: { type: 'group', groupId: 111, groupName: null },
      count: 1,
      firstRowId: 1,
      throughRowId: 1,
      recentAfterRowId: 0,
      senderCount: 1,
      timeRange: { from: new Date('2026-07-03T00:00:00Z'), to: new Date('2026-07-03T00:00:00Z') },
    }), 'qq_group:111')
    assert.equal(mailboxKeyForEvent({ type: 'wake' }), null)
  })
})
