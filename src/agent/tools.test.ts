import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentTools } from './tools.js'

describe('createAgentTools', () => {
  test('declares mandatory atomic tools and removes legacy tool names', () => {
    const { declarations } = createAgentTools(123456)
    const names = declarations.map((d) => d.name)

    assert.deepEqual(names.includes('db_schema'), true)
    assert.deepEqual(names.includes('db_read'), true)
    assert.deepEqual(names.includes('final_answer'), true)

    assert.deepEqual(names.includes('search_messages'), false)
    assert.deepEqual(names.includes('get_recent_messages'), false)
    assert.deepEqual(names.includes('lookup_group_member'), false)
    assert.deepEqual(names.includes('get_user_profile'), false)
    assert.deepEqual(names.includes('get_group_summary'), false)
  })

  test('db_read schema requires sql and accepts optional params object', () => {
    const { declarations } = createAgentTools(1)
    const dbRead = declarations.find((d) => d.name === 'db_read')
    assert.ok(dbRead)

    const ok1 = dbRead.inputSchema.parse({ sql: 'select 1 where group_id = :group_id' }) as {
      sql: string
      params?: Record<string, unknown>
    }
    assert.equal(ok1.sql.includes('select 1'), true)
    assert.equal(ok1.params, undefined)

    const ok2 = dbRead.inputSchema.parse({
      sql: 'select 1 where group_id = :group_id and sender_id = :sender_id',
      params: { sender_id: 10001 },
    }) as { params: Record<string, unknown> }
    assert.equal(ok2.params.sender_id, 10001)
  })
})
