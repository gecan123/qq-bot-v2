import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createInMemoryTaskRegistry } from '../background-task-registry.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import { createDbTool } from './db.js'
import { buildBotToolManifest } from './index.js'
import type { SendTargetPolicy } from '../send-target-policy.js'
import type { ScheduleRuntime } from '../schedule-runtime.js'
import type { QqConversationController } from './qq-conversation.js'

const mockSender: MessageSender = {
  async sendSegments() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
}

const targetPolicy: SendTargetPolicy = {
  async authorize() {
    return { allowed: true }
  },
}

const conversations: QqConversationController = {
  getCurrent() { return null },
  async resolveCurrent() { return { ok: false, code: 'CHAT_CONTEXT_UNAVAILABLE' } },
  async open() { return { ok: false, code: 'CHAT_TARGET_UNAVAILABLE', current: null } },
  close() {},
  async list() { return [] },
}

const scheduleRuntime: ScheduleRuntime = {
  async start() {},
  async create() { throw new Error('not used') },
  async list() { return [] },
  async getOccurrence() { return null },
  async cancel(id) { return { status: 'already_absent', id } },
  async stop() {},
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

  test('bot tool registry keeps database access out of the main Agent', () => {
    const manifest = buildBotToolManifest({
      sender: mockSender,
      targetPolicy,
      conversations,
      selfNumber: 999,
      taskRegistry: createInMemoryTaskRegistry(),
      scheduleRuntime,
      groupIds: [],
      metadata: { groupNames: new Map() },
      groupPolicies: [],
      qqDirectory: {
        groupIds: [],
        async loadFriends() { return [] },
        async loadGroups() { return [] },
      },
    })
    const database = manifest.capabilities.find((capability) => capability.name === 'database_read')

    assert.equal(database, undefined)
  })
})
