import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createInboxTool, INBOX_OUTPUT_CAP_CHARS, type InboxMessageRow } from './inbox.js'

function row(input: {
  id: number
  kind?: 'qq_group' | 'qq_private'
  sourceId?: string
  text?: string
  content?: unknown
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
    content: input.content ?? [{ type: 'text', content: input.text ?? `message-${input.id}` }],
    sentAt: new Date(`2026-07-03T00:00:${String(input.id % 60).padStart(2, '0')}Z`),
    createdAt: new Date(`2026-07-03T00:00:${String(input.id % 60).padStart(2, '0')}Z`),
  }
}

describe('inbox tool', () => {
  test('reads an explicit monitored group in ascending row order', async () => {
    const calls: unknown[] = []
    const tool = createInboxTool({
      groupIds: [111],
      selfNumber: 999,
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
    const payload = JSON.parse(result.content as string) as {
      messages: Array<{ rowId: number; text: string; replyable: boolean }>
    }
    assert.deepEqual(payload.messages.map((message) => message.rowId), [11, 12])
    assert.equal(payload.messages[0]!.text, 'message-11')
    assert.equal(payload.messages[0]!.replyable, true)
    assert.equal(result.outcome?.progress, true)
    assert.deepEqual(result.outcome?.evidenceMessageRowIds, [11, 12])
    assert.deepEqual(result.effects, [{
      type: 'inbox_read',
      mailbox: 'qq_group:111',
      throughRowId: 12,
    }])

    const repeated = await tool.execute({
      action: 'read',
      source: 'group',
      groupId: 111,
      afterRowId: 10,
      limit: 2,
    }, undefined as never)
    assert.deepEqual(repeated.outcome, {
      ok: true,
      code: 'unchanged',
      progress: false,
      evidenceMessageRowIds: [11, 12],
    })
  })

  test('empty mailbox read is an explicit no-progress result', async () => {
    const tool = createInboxTool({
      groupIds: [111],
      selfNumber: 999,
      async findMessages() { return [] },
    })

    const result = await tool.execute({
      action: 'read',
      source: 'group',
      groupId: 111,
      afterRowId: 10,
    }, undefined as never)

    assert.deepEqual(result.outcome, { ok: true, code: 'empty', progress: false })
  })

  test('exposes structured mention targets without treating plain-text @你 as a bot mention', async () => {
    const tool = createInboxTool({
      groupIds: [111],
      selfNumber: 3999414673,
      async findMessages() {
        return [
          row({ id: 1, text: '@你人呢' }),
          row({ id: 2, text: '@2070979806', content: [{ type: 'at', targetId: '2070979806' }] }),
          row({ id: 3, text: '@3999414673', content: [{ type: 'at', targetId: '3999414673' }] }),
        ]
      },
    })

    const result = await tool.execute({
      action: 'read',
      source: 'group',
      groupId: 111,
    }, undefined as never)
    const payload = JSON.parse(result.content as string) as {
      messages: Array<{ mentionedSelf: boolean; mentionTargets: string[] }>
    }

    assert.deepEqual(payload.messages.map(({ mentionedSelf, mentionTargets }) => ({
      mentionedSelf,
      mentionTargets,
    })), [
      { mentionedSelf: false, mentionTargets: [] },
      { mentionedSelf: false, mentionTargets: ['2070979806'] },
      { mentionedSelf: true, mentionTargets: ['3999414673'] },
    ])
  })

  test('exposes valid media handles in original segment order', async () => {
    const tool = createInboxTool({
      groupIds: [111],
      selfNumber: 999,
      async findMessages() {
        return [
          row({
            id: 1,
            content: [
              { type: 'text', content: '看看' },
              { type: 'image', referenceId: '101' },
              { type: 'video', referenceId: '102' },
              { type: 'record', referenceId: '103' },
              { type: 'file', referenceId: '104', fileName: 'report.pdf', fileSize: '12345' },
              { type: 'face', referenceId: '105' },
              { type: 'image' },
              { type: 'image', referenceId: '0' },
              { type: 'image', referenceId: '-1' },
              { type: 'image', referenceId: '1.5' },
              { type: 'image', referenceId: 'not-a-number' },
            ],
          }),
          row({ id: 2 }),
        ]
      },
    })

    assert.match(tool.description, /media.*mediaId/)

    const result = await tool.execute({
      action: 'read',
      source: 'group',
      groupId: 111,
    }, undefined as never)
    const payload = JSON.parse(result.content as string) as {
      messages: Array<{ media: Array<{ type: string; mediaId: number }> }>
    }

    assert.deepEqual(payload.messages[0]!.media, [
      { type: 'image', mediaId: 101 },
      { type: 'video', mediaId: 102 },
      { type: 'record', mediaId: 103 },
      { type: 'file', mediaId: 104, fileName: 'report.pdf', fileSize: '12345' },
    ])
    assert.deepEqual(payload.messages[1]!.media, [])
  })

  test('exposes media handles nested inside forwarded messages', async () => {
    const tool = createInboxTool({
      groupIds: [111],
      selfNumber: 999,
      async findMessages() {
        return [row({
          id: 1,
          content: [{
            type: 'forward',
            forwardId: 'forward-1',
            items: [
              { content: [{ type: 'image', referenceId: '201' }] },
              {
                content: [{
                  type: 'forward',
                  forwardId: 'forward-2',
                  items: [{ content: [{ type: 'video', referenceId: '202' }] }],
                }],
              },
            ],
          }],
        })]
      },
    })

    const result = await tool.execute({
      action: 'read',
      source: 'group',
      groupId: 111,
    }, undefined as never)
    const payload = JSON.parse(result.content as string) as {
      messages: Array<{ media: Array<{ type: string; mediaId: number }> }>
    }

    assert.deepEqual(payload.messages[0]!.media, [
      { type: 'image', mediaId: 201 },
      { type: 'video', mediaId: 202 },
    ])
  })

  test('rejects reads from groups outside the monitored allowlist', async () => {
    let queried = false
    const tool = createInboxTool({
      groupIds: [111],
      selfNumber: 999,
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
      selfNumber: 999,
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

  test('returns compensated prior messages separately from the new mailbox batch', async () => {
    const calls: unknown[] = []
    const tool = createInboxTool({
      groupIds: [],
      selfNumber: 999,
      async findMessages(args) {
        calls.push(args)
        const idFilter = args.where.id as { gt?: number; lte?: number }
        if (idFilter.gt != null) {
          return [row({ id: 30, kind: 'qq_private', sourceId: '9001', text: 'current' })]
        }
        return [
          row({ id: 29, kind: 'qq_private', sourceId: '9001', text: 'previous-nearest' }),
          row({ id: 28, kind: 'qq_private', sourceId: '9001', text: 'previous-older' }),
        ]
      },
    })

    const result = await tool.execute({
      action: 'read',
      source: 'private',
      peerId: 9001,
      afterRowId: 29,
      contextBefore: 2,
      limit: 1,
    }, undefined as never)

    assert.deepEqual(calls, [
      {
        where: { sceneKind: 'qq_private', sceneExternalId: '9001', id: { gt: 29 } },
        orderBy: { id: 'asc' },
        take: 1,
      },
      {
        where: { sceneKind: 'qq_private', sceneExternalId: '9001', id: { lte: 29 } },
        orderBy: { id: 'desc' },
        take: 2,
      },
    ])
    const payload = JSON.parse(result.content as string) as {
      requestedContextBefore: number
      previousMessages: Array<{ rowId: number; text: string }>
      messages: Array<{ rowId: number; text: string }>
    }
    assert.equal(payload.requestedContextBefore, 2)
    assert.deepEqual(payload.previousMessages.map((message) => message.rowId), [28, 29])
    assert.deepEqual(payload.messages.map((message) => message.rowId), [30])
  })

  test('lists one latest entry per allowed mailbox', async () => {
    const tool = createInboxTool({
      groupIds: [111],
      selfNumber: 999,
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
      { mailbox: 'qq_group:111', label: '测试群', latestRowId: 5, lastReadRowId: 0 },
      { mailbox: 'qq_private:9001', label: 'sender', latestRowId: 3, lastReadRowId: 0 },
    ])
  })

  test('lists only pending sources and reads from the persisted cursor by default', async () => {
    const calls: unknown[] = []
    const readCursors = { 'qq_group:111': 4, 'qq_private:9001': 3 }
    const tool = createInboxTool({
      groupIds: [111],
      selfNumber: 999,
      getReadCursors: () => readCursors,
      async findMessages(args) {
        calls.push(args)
        if (args.orderBy.id === 'desc') {
          return [
            row({ id: 5, sourceId: '111' }),
            row({ id: 3, kind: 'qq_private', sourceId: '9001' }),
          ]
        }
        return [row({ id: 5, sourceId: '111' })]
      },
    })

    const listed = await tool.execute({ action: 'list' }, undefined as never)
    const listPayload = JSON.parse(listed.content as string) as {
      mailboxes: Array<{ mailbox: string }>
    }
    assert.deepEqual(listPayload.mailboxes.map(({ mailbox }) => mailbox), ['qq_group:111'])

    await tool.execute({ action: 'read', source: 'group', groupId: 111 }, undefined as never)
    assert.deepEqual(calls.at(-1), {
      where: { sceneKind: 'qq_group', groupId: 111n, id: { gt: 4 } },
      orderBy: { id: 'asc' },
      take: 20,
    })
  })

  test('caps read output even when stored messages are large', async () => {
    const tool = createInboxTool({
      groupIds: [111],
      selfNumber: 999,
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
    const payload = JSON.parse(result.content as string) as { messages: Array<{ rowId: number }> }
    assert.deepEqual(result.effects, [{
      type: 'inbox_read',
      mailbox: 'qq_group:111',
      throughRowId: payload.messages.at(-1)!.rowId,
    }])
    assert.ok(payload.messages.at(-1)!.rowId < 20, '未展示的截断行不能被标成已读')
  })
})
