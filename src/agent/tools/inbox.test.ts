import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createInboxTool, INBOX_OUTPUT_CAP_CHARS, type InboxMessageRow } from './inbox.js'

function row(input: {
  id: number
  kind?: 'qq_group' | 'qq_private'
  sourceId?: string
  text?: string
}): InboxMessageRow {
  const kind = input.kind ?? 'qq_group'
  const sourceId = input.sourceId ?? '111'
  return {
    id: input.id,
    sceneKind: kind,
    sceneExternalId: kind === 'qq_private' ? sourceId : '',
    groupId: kind === 'qq_group' ? BigInt(sourceId) : null,
    groupName: kind === 'qq_group' ? '测试群' : null,
    messageId: BigInt(10_000 + input.id),
    senderId: BigInt(kind === 'qq_group' ? 123 : sourceId),
    senderNickname: 'sender',
    senderGroupNickname: null,
    resolvedText: input.text ?? `message-${input.id}`,
    searchText: input.text ?? `message-${input.id}`,
    sentAt: new Date(`2026-07-03T00:00:${String(input.id % 60).padStart(2, '0')}Z`),
    createdAt: new Date(`2026-07-03T00:00:${String(input.id % 60).padStart(2, '0')}Z`),
  }
}

describe('inbox tool', () => {
  test('reads an explicit monitored group in ascending row order', async () => {
    const calls: unknown[] = []
    const tool = createInboxTool({
      groupIds: [111],
      async findMessages(args) {
        calls.push(args)
        return [row({ id: 11 }), row({ id: 12 })]
      },
    })

    const result = await tool.execute({
      action: 'read',
      source: 'group',
      groupId: 111,
      afterRowId: 10,
      limit: 2,
    }, undefined as never)

    assert.deepEqual(calls, [{
      where: { sceneKind: 'qq_group', groupId: 111n, id: { gt: 10 } },
      orderBy: { id: 'asc' },
      take: 2,
    }])
    const payload = JSON.parse(result.content as string) as { messages: Array<{ rowId: number; text: string }> }
    assert.deepEqual(payload.messages.map((message) => message.rowId), [11, 12])
    assert.equal(payload.messages[0]!.text, 'message-11')
  })

  test('rejects reads from groups outside the monitored allowlist', async () => {
    let queried = false
    const tool = createInboxTool({
      groupIds: [111],
      async findMessages() {
        queried = true
        return []
      },
    })

    const result = await tool.execute({ action: 'read', source: 'group', groupId: 222 }, undefined as never)

    assert.equal(queried, false)
    assert.match(result.content as string, /groupId=222 is not monitored/)
  })

  test('reads an explicit private mailbox without the group allowlist', async () => {
    const calls: unknown[] = []
    const tool = createInboxTool({
      groupIds: [],
      async findMessages(args) {
        calls.push(args)
        return [row({ id: 7, kind: 'qq_private', sourceId: '9001' })]
      },
    })

    const result = await tool.execute({
      action: 'read',
      source: 'private',
      peerId: 9001,
      afterRowId: 0,
    }, undefined as never)

    assert.deepEqual(calls, [{
      where: { sceneKind: 'qq_private', sceneExternalId: '9001', id: { gt: 0 } },
      orderBy: { id: 'asc' },
      take: 20,
    }])
    assert.match(result.content as string, /qq_private:9001/)
  })

  test('lists one latest entry per allowed mailbox', async () => {
    const tool = createInboxTool({
      groupIds: [111],
      async findMessages() {
        return [
          row({ id: 5, sourceId: '111' }),
          row({ id: 4, sourceId: '111' }),
          row({ id: 3, kind: 'qq_private', sourceId: '9001' }),
        ]
      },
    })

    const result = await tool.execute({ action: 'list' }, undefined as never)
    const payload = JSON.parse(result.content as string) as { mailboxes: Array<{ mailbox: string; latestRowId: number }> }

    assert.deepEqual(payload.mailboxes, [
      { mailbox: 'qq_group:111', label: '测试群', latestRowId: 5 },
      { mailbox: 'qq_private:9001', label: 'sender', latestRowId: 3 },
    ])
  })

  test('caps read output even when stored messages are large', async () => {
    const tool = createInboxTool({
      groupIds: [111],
      async findMessages() {
        return Array.from({ length: 20 }, (_, index) => row({
          id: index + 1,
          text: `body-${index}-${'x'.repeat(2_000)}`,
        }))
      },
    })

    const result = await tool.execute({ action: 'read', source: 'group', groupId: 111 }, undefined as never)

    assert.ok((result.content as string).length <= INBOX_OUTPUT_CAP_CHARS)
    assert.match(result.content as string, /"truncated": true/)
  })
})
