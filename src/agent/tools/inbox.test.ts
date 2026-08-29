import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ToolContext } from '../tool.js'
import type { BotEvent } from '../event.js'
import { InMemoryEventQueue } from '../event-queue.js'
import {
  createInboxTool,
  INBOX_OUTPUT_CAP_CHARS,
  type InboxMessageRow,
  type InboxToolDeps,
} from './inbox.js'

const qqGroup = {
  platform: 'qq' as const,
  accountId: '10000',
  kind: 'group' as const,
  externalId: '20000',
}
const feishuOwner = {
  platform: 'feishu' as const,
  accountId: 'cli_1',
  kind: 'private' as const,
  externalId: 'oc_owner',
}

function context(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

function row(input: {
  rowId: number
  conversation?: typeof qqGroup | typeof feishuOwner
  eventKind?: 'message' | 'edit' | 'recall'
  content?: unknown
  text?: string
}): InboxMessageRow {
  const conversation = input.conversation ?? qqGroup
  return {
    rowId: input.rowId,
    eventKind: input.eventKind ?? 'message',
    platform: conversation.platform,
    accountId: conversation.accountId,
    conversationKind: conversation.kind,
    conversationExternalId: conversation.externalId,
    conversationName: conversation.kind === 'group' ? '测试群' : null,
    messageExternalId: conversation.platform === 'qq' ? String(1000 + input.rowId) : `om_${input.rowId}`,
    senderExternalId: conversation.platform === 'qq' ? '30000' : 'ou_owner',
    senderName: 'Alice',
    senderConversationName: null,
    content: input.content ?? [{ type: 'text', content: input.text ?? `text-${input.rowId}` }],
    resolvedText: input.text ?? `text-${input.rowId}`,
    searchText: input.text ?? `text-${input.rowId}`,
    sentAt: null,
    createdAt: new Date(Date.parse('2026-08-21T00:00:00Z') + input.rowId * 1_000),
  }
}

function tool(overrides: Partial<InboxToolDeps> = {}) {
  return createInboxTool({
    allowedConversations: [qqGroup, feishuOwner],
    selfExternalIds: { qq: '10000', feishu: 'ou_bot' },
    findMessages: async () => [],
    ...overrides,
  })
}

function parse(content: unknown): Record<string, any> {
  return JSON.parse(content as string)
}

describe('inbox tool', () => {
  test('reads an allowed conversation in ascending local row order', async () => {
    const calls: unknown[] = []
    const inbox = tool({
      findMessages: async (args) => {
        calls.push(args)
        return [row({ rowId: 11 }), row({ rowId: 12 })]
      },
    })

    const result = await inbox.execute({
      action: 'read',
      conversation: qqGroup,
      afterRowId: 10,
      limit: 2,
    }, context())
    const payload = parse(result.content)

    assert.deepEqual(calls, [{
      where: {
        platform: 'qq',
        accountId: '10000',
        conversationKind: 'group',
        conversationExternalId: '20000',
        rowId: { gt: 10 },
      },
      orderBy: { rowId: 'asc' },
      take: 2,
    }])
    assert.deepEqual(payload.messages.map((message: any) => message.rowId), [11, 12])
    assert.equal(payload.messages[0].mailbox, 'qq:10000:group:20000')
    assert.equal(payload.messages[0].messageExternalId, '1011')
    assert.equal(payload.messages[0].sentAt, '2026-08-21T08:00+08:00')
    assert.deepEqual(result.effects, [{
      type: 'inbox_read',
      mailbox: 'qq:10000:group:20000',
      throughRowId: 12,
    }])
  })

  test('recovers pending high-priority notification defaults when the model omits afterRowId', async () => {
    const calls: unknown[] = []
    const inbox = tool({
      getReadCursors: () => ({ 'qq:10000:group:20000': 20 }),
      getPendingReadDefaults: () => ({ afterRowId: 43, contextBefore: 2 }),
      findMessages: async (args) => {
        calls.push(args)
        return args.orderBy.rowId === 'asc'
          ? [row({
              rowId: 51,
              content: [{ type: 'at', targetId: '10000' }, { type: 'text', content: '看一下' }],
              text: '@10000看一下',
            })]
          : [row({ rowId: 43 })]
      },
    })

    const result = await inbox.execute({
      action: 'read',
      conversation: qqGroup,
      limit: 10,
    }, context())

    assert.deepEqual(calls, [
      {
        where: {
          platform: 'qq',
          accountId: '10000',
          conversationKind: 'group',
          conversationExternalId: '20000',
          rowId: { gt: 43 },
        },
        orderBy: { rowId: 'asc' },
        take: 10,
      },
      {
        where: {
          platform: 'qq',
          accountId: '10000',
          conversationKind: 'group',
          conversationExternalId: '20000',
          rowId: { lte: 43 },
        },
        orderBy: { rowId: 'desc' },
        take: 2,
      },
    ])
    const payload = parse(result.content)
    assert.equal(payload.messages[0].rowId, 51)
    assert.equal(payload.messages[0].mentionedSelf, true)
    assert.deepEqual(result.effects, [{
      type: 'inbox_read',
      mailbox: 'qq:10000:group:20000',
      throughRowId: 51,
    }])
  })

  test('renders edits and recalls as explicit corrections', async () => {
    const inbox = tool({
      findMessages: async () => [
        row({ rowId: 20, conversation: feishuOwner, eventKind: 'edit', text: '新正文' }),
        row({ rowId: 21, conversation: feishuOwner, eventKind: 'recall', text: '' }),
      ],
    })

    const result = await inbox.execute({
      action: 'read',
      conversation: feishuOwner,
      afterRowId: 19,
    }, context())
    const payload = parse(result.content)

    assert.equal(payload.messages[0].text, '[消息已编辑: om_20]\n新正文')
    assert.equal(payload.messages[1].text, '[消息已撤回: om_21]')
    assert.equal(payload.messages[0].replyable, true)
    assert.equal(payload.messages[1].replyable, false)
  })

  test('exposes structured mentions and media handles without guessing from plain text', async () => {
    const inbox = tool({
      findMessages: async () => [row({
        rowId: 30,
        text: '@你 看文件',
        content: [
          { type: 'text', content: '@你 看文件' },
          { type: 'at', targetId: '10000' },
          { type: 'image', referenceId: '42', fileName: 'photo.png', fileSize: '123' },
          { type: 'file', referenceId: '43', fileName: 'report.pdf', fileSize: '456' },
        ],
      })],
    })

    const result = await inbox.execute({
      action: 'read',
      conversation: qqGroup,
    }, context())
    const message = parse(result.content).messages[0]

    assert.equal(message.mentionedSelf, true)
    assert.deepEqual(message.mentionTargets, ['10000'])
    assert.deepEqual(message.media, [
      { type: 'image', mediaId: 42, fileName: 'photo.png', fileSize: '123' },
      { type: 'file', mediaId: 43, fileName: 'report.pdf', fileSize: '456' },
    ])
  })

  test('rejects conversations outside the configured allowlist', async () => {
    const result = await tool().execute({
      action: 'read',
      conversation: { ...qqGroup, externalId: '99999' },
    }, context())

    assert.deepEqual(parse(result.content), {
      ok: false,
      error: 'conversation=qq:10000:group:99999 is not allowed',
    })
  })

  test('lists pending mailboxes across platforms using persisted read cursors', async () => {
    const inbox = tool({
      getReadCursors: () => ({
        'qq:10000:group:20000': 5,
        'feishu:cli_1:private:oc_owner': 9,
      }),
      findMessages: async () => [
        row({ rowId: 10, conversation: feishuOwner }),
        row({ rowId: 8 }),
        row({ rowId: 4 }),
      ],
    })

    const payload = parse((await inbox.execute({ action: 'list' }, context())).content)
    assert.deepEqual(payload.mailboxes.map((mailbox: any) => [
      mailbox.mailbox,
      mailbox.latestRowId,
      mailbox.lastReadRowId,
    ]), [
      ['feishu:cli_1:private:oc_owner', 10, 9],
      ['qq:10000:group:20000', 8, 5],
    ])
  })

  test('caps large outputs', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => row({
      rowId: 100 + index,
      text: `message-${index}-${'x'.repeat(3_000)}`,
    }))
    const result = await tool({ findMessages: async () => rows }).execute({
      action: 'read',
      conversation: qqGroup,
    }, context())

    assert.ok((result.content as string).length <= INBOX_OUTPUT_CAP_CHARS)
    assert.equal(parse(result.content).truncated, true)
  })
})
