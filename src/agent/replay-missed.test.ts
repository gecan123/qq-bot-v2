import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import type { Message, Prisma } from '../generated/prisma/client.js'
import { prisma } from '../database/client.js'
import type { BotEvent } from './event.js'
import { replayMissedMessages } from './replay-missed.js'

function messageRow(input: {
  rowId: number
  platform: 'qq' | 'feishu'
  accountId: string
  kind: 'group' | 'private'
  conversationId: string
  messageId: string
  senderId: string
  text: string
  mentionedSelf?: string
  eventKind?: 'message' | 'edit' | 'recall'
}): Message {
  return {
    rowId: input.rowId,
    eventKind: input.eventKind ?? 'message',
    eventExternalId: `${input.eventKind ?? 'message'}:${input.messageId}`,
    platform: input.platform,
    accountId: input.accountId,
    conversationKind: input.kind,
    conversationExternalId: input.conversationId,
    conversationName: input.kind === 'group' ? '测试群' : null,
    mediaReferenceIds: [],
    messageExternalId: input.messageId,
    replyToExternalId: null,
    rootExternalId: null,
    threadExternalId: null,
    senderExternalId: input.senderId,
    senderName: 'sender',
    senderConversationName: null,
    content: [
      ...(input.mentionedSelf ? [{ type: 'at', targetId: input.mentionedSelf }] : []),
      { type: 'text', content: input.text },
    ] as never,
    rawContent: null,
    rawMessage: input.text,
    searchText: input.text,
    resolvedText: input.text,
    sentAt: null,
    createdAt: new Date(`2026-08-21T00:00:${String(input.rowId).padStart(2, '0')}Z`),
  }
}

const originalFindMany = prisma.message.findMany
const originalCount = prisma.message.count
const originalFindFirst = prisma.message.findFirst

afterEach(() => {
  ;(prisma.message as unknown as { findMany: typeof prisma.message.findMany }).findMany = originalFindMany
  ;(prisma.message as unknown as { count: typeof prisma.message.count }).count = originalCount
  ;(prisma.message as unknown as { findFirst: typeof prisma.message.findFirst }).findFirst = originalFindFirst
})

function stubFindMany(
  handler: (args: { where?: Prisma.MessageWhereInput }) => Message[],
): Array<{ where?: Prisma.MessageWhereInput }> {
  const calls: Array<{ where?: Prisma.MessageWhereInput }> = []
  ;(prisma.message as unknown as {
    findMany(args: { where?: Prisma.MessageWhereInput }): Promise<Message[]>
  }).findMany = async (args) => {
    calls.push(structuredClone(args))
    return handler(args)
  }
  return calls
}

const ensureReady = async (message: Message) => ({
  renderedText: message.resolvedText ?? '',
  fromFrozen: true,
})

describe('replayMissedMessages', () => {
  test('does not replay history on a cold start', async () => {
    let queried = false
    stubFindMany(() => {
      queried = true
      return []
    })

    const result = await replayMissedMessages({
      mailboxCursors: {},
      legacyLastWakeAt: null,
    }, {
      enqueueMessageEvent: () => true,
      allowedConversations: [{
        platform: 'qq',
        accountId: '10000',
        kind: 'group',
        externalId: '20000',
      }],
      selfExternalIds: { qq: '10000' },
      ensureReady,
    })

    assert.deepEqual(result, { enqueued: 0, skippedDuplicates: 0 })
    assert.equal(queried, false)
  })

  test('replays QQ and Feishu through one row-id ordered Agent event contract', async () => {
    const qq = messageRow({
      rowId: 2,
      platform: 'qq',
      accountId: '10000',
      kind: 'group',
      conversationId: '20000',
      messageId: '101',
      senderId: '30000',
      text: 'qq',
      mentionedSelf: '10000',
    })
    const feishu = messageRow({
      rowId: 3,
      platform: 'feishu',
      accountId: 'cli_1',
      kind: 'private',
      conversationId: 'oc_owner',
      messageId: 'om_1',
      senderId: 'ou_owner',
      text: 'feishu',
    })
    const calls = stubFindMany(({ where }) => where?.platform === 'qq' ? [qq] : [feishu])
    const events: BotEvent[] = []

    const result = await replayMissedMessages({
      mailboxCursors: {
        'qq:10000:group:20000': 1,
        'feishu:cli_1:private:oc_owner': 1,
      },
      legacyLastWakeAt: null,
    }, {
      enqueueMessageEvent: (event) => {
        events.push(event)
        return true
      },
      allowedConversations: [
        { platform: 'qq', accountId: '10000', kind: 'group', externalId: '20000' },
        { platform: 'feishu', accountId: 'cli_1', kind: 'private', externalId: 'oc_owner' },
      ],
      selfExternalIds: { qq: '10000', feishu: 'ou_bot' },
      ensureReady,
    })

    assert.deepEqual(result, { enqueued: 2, skippedDuplicates: 0 })
    assert.deepEqual(events.map((event) => event.type === 'chat_message'
      ? [event.messageRowId, event.conversation.platform, event.messageExternalId]
      : null), [
      [2, 'qq', '101'],
      [3, 'feishu', 'om_1'],
    ])
    assert.equal(calls.length, 2)
  })

  test('keeps ordinary group rows passive unless their conversation opts in', async () => {
    const ordinary = messageRow({
      rowId: 4,
      platform: 'feishu',
      accountId: 'cli_1',
      kind: 'group',
      conversationId: 'oc_group',
      messageId: 'om_2',
      senderId: 'ou_member',
      text: 'ambient',
    })
    stubFindMany(() => [ordinary])
    const conversation = {
      platform: 'feishu' as const,
      accountId: 'cli_1',
      kind: 'group' as const,
      externalId: 'oc_group',
    }

    const hidden = await replayMissedMessages({
      mailboxCursors: { 'feishu:cli_1:group:oc_group': 1 },
      legacyLastWakeAt: null,
    }, {
      enqueueMessageEvent: () => true,
      allowedConversations: [conversation],
      selfExternalIds: { feishu: 'ou_bot' },
      ensureReady,
    })
    const passive = await replayMissedMessages({
      mailboxCursors: { 'feishu:cli_1:group:oc_group': 1 },
      legacyLastWakeAt: null,
    }, {
      enqueueMessageEvent: () => true,
      allowedConversations: [conversation],
      passiveConversationKeys: ['feishu:cli_1:group:oc_group'],
      selfExternalIds: { feishu: 'ou_bot' },
      ensureReady,
    })

    assert.deepEqual(hidden, { enqueued: 0, skippedDuplicates: 0 })
    assert.deepEqual(passive, { enqueued: 1, skippedDuplicates: 0 })
  })
})
