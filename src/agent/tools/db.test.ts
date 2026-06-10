import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createInMemoryTaskRegistry } from '../background-task-registry.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import { createDbTool } from './db.js'
import { buildBotTools } from './index.js'

const mockSender: MessageSender = {
  async replyToMessage() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
  async sendPrivateMessage() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
  async sendGroupMessage() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
  async sendSegments() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
}

describe('db tool', () => {
  test('schema action returns the database schema payload', async () => {
    const tool = createDbTool({
      async executeRead() {
        throw new Error('query executor should not be called for schema')
      },
    })

    const result = await tool.execute({ action: 'schema' }, undefined as never)

    assert.equal(typeof result.content, 'string')
    assert.match(result.content as string, /"dialect": "postgresql"/)
    assert.match(result.content as string, /"messages"/)
    assert.match(result.content as string, /"media"/)
  })

  test('query action delegates to the read-only SQL executor', async () => {
    const calls: unknown[] = []
    const tool = createDbTool({
      async executeRead(input) {
        calls.push(input)
        return { rows: [{ count: 1 }], rowCount: 1 }
      },
      groupIdWhitelist: [123],
    })

    const result = await tool.execute({
      action: 'query',
      sql: 'select count(*) from messages where group_id=:group_id',
      params: { group_id: 123 },
    }, undefined as never)

    assert.deepEqual(calls, [{
      sql: 'select count(*) from messages where group_id=:group_id',
      params: { group_id: 123 },
      groupIdWhitelist: [123],
      maxRows: 200,
      statementTimeoutMs: 8000,
      maxOutputChars: 8000,
    }])
    assert.match(result.content as string, /"rowCount": 1/)
  })

  test('bot tool registry exposes db instead of db_schema and db_read', () => {
    const names = buildBotTools({
      sender: mockSender,
      groupAmbientSendIds: new Set(),
      taskRegistry: createInMemoryTaskRegistry(),
      groupIds: [],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
    }).map((tool) => tool.name)

    assert.ok(names.includes('db'))
    assert.equal(names.includes('db_schema'), false)
    assert.equal(names.includes('db_read'), false)
  })
})
