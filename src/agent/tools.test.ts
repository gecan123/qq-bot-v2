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

  test('final_answer schema requires structured reply control fields', () => {
    const { declarations } = createAgentTools(1)
    const finalAnswer = declarations.find((d) => d.name === 'final_answer')
    assert.ok(finalAnswer)

    const parsed = finalAnswer.inputSchema.parse({
      replyText: '今晚七点可以。',
      confidence: 'high',
      shouldReferenceContext: true,
      shouldAskClarifyingQuestion: false,
      contextCitations: ['你刚才提到“今晚七点”'],
    }) as {
      replyText: string
      confidence: string
      shouldReferenceContext: boolean
      shouldAskClarifyingQuestion: boolean
      contextCitations?: string[]
    }
    assert.equal(parsed.replyText, '今晚七点可以。')
    assert.equal(parsed.confidence, 'high')
    assert.equal(parsed.shouldReferenceContext, true)
    assert.equal(parsed.shouldAskClarifyingQuestion, false)
    assert.deepEqual(parsed.contextCitations, ['你刚才提到“今晚七点”'])

    assert.throws(() => finalAnswer.inputSchema.parse({ text: '旧格式' }))
  })

  test('db_schema exposes media description_raw instead of deleted description column', async () => {
    const { executors } = createAgentTools(1)
    const payload = JSON.parse(await executors.db_schema({})) as {
      tables: Array<{ name: string; columns: string[] }>
    }

    const mediaTable = payload.tables.find((table) => table.name === 'media')
    assert.ok(mediaTable)
    assert.equal(mediaTable.columns.includes('description_raw'), true)
    assert.equal(mediaTable.columns.includes('description'), false)
  })
})
