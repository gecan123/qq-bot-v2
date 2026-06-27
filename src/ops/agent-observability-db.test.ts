import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildInsertAgentTokenUsageSql, buildInsertAgentToolCallSql } from './agent-observability-db.js'

describe('agent observability db SQL', () => {
  test('builds tool-call insert with all persisted fields', () => {
    const sql = buildInsertAgentToolCallSql({
      ts: '2026-06-26T10:00:00.000Z',
      toolCallId: 'call_1',
      toolName: 'fetch_url',
      roundIndex: 7,
      argsSummary: { url: 'https://example.com' },
      durationMs: 123,
      ok: false,
      sideEffect: false,
      error: 'timeout',
    })

    assert.match(sql.sql, /INSERT INTO "agent_tool_calls"/)
    assert.match(sql.sql, /"tool_call_id"/)
    assert.match(sql.sql, /"args_summary"/)
    assert.deepEqual(sql.values, [
      new Date('2026-06-26T10:00:00.000Z'),
      'call_1',
      'fetch_url',
      7,
      '{"url":"https://example.com"}',
      123,
      false,
      false,
      'timeout',
    ])
  })

  test('builds token-usage insert with cache hit rate', () => {
    const sql = buildInsertAgentTokenUsageSql({
      ts: '2026-06-26T10:00:00.000Z',
      operation: 'agent.chat',
      roundIndex: 8,
      inputTokens: 100,
      cachedTokens: 80,
      outputTokens: 10,
      model: 'gpt-5',
      cacheHitRate: 0.8,
    })

    assert.match(sql.sql, /INSERT INTO "agent_token_usage"/)
    assert.match(sql.sql, /"cache_hit_rate"/)
    assert.deepEqual(sql.values, [
      new Date('2026-06-26T10:00:00.000Z'),
      'agent.chat',
      8,
      'gpt-5',
      100,
      80,
      10,
      0.8,
    ])
  })
})
