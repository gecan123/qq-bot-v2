import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildInsertAgentTokenUsageSql,
  buildInsertAgentToolCallSql,
  buildSelectAgentTokenUsageSql,
} from './agent-observability-db.js'

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

  test('builds an LLM-call insert with trace metadata and content-free evidence', () => {
    const sql = buildInsertAgentTokenUsageSql({
      ts: '2026-06-26T10:00:00.000Z',
      callId: '11111111-1111-4111-8111-111111111111',
      operation: 'agent.chat',
      actor: 'main_agent',
      roundIndex: 8,
      provider: 'claude-code',
      status: 'succeeded',
      durationMs: 125,
      stopReason: 'tool_use',
      inputTokens: 100,
      cachedTokens: 80,
      outputTokens: 10,
      model: 'gpt-5',
      cacheHitRate: 0.8,
      evidence: {
        canonicalRequest: {
          fingerprint: 'a'.repeat(64),
          summary: { messageCount: 1, toolNames: ['inbox'] },
        },
      },
    })

    assert.match(sql.sql, /INSERT INTO "agent_token_usage"/)
    assert.match(sql.sql, /"call_id"/)
    assert.match(sql.sql, /"evidence"/)
    assert.match(sql.sql, /"cache_hit_rate"/)
    assert.deepEqual(sql.values, [
      new Date('2026-06-26T10:00:00.000Z'),
      '11111111-1111-4111-8111-111111111111',
      'agent.chat',
      'main_agent',
      8,
      'claude-code',
      'succeeded',
      125,
      'tool_use',
      null,
      null,
      null,
      'gpt-5',
      100,
      80,
      10,
      0.8,
      `{"canonicalRequest":{"fingerprint":"${'a'.repeat(64)}","summary":{"messageCount":1,"toolNames":["inbox"]}}}`,
    ])
  })

  test('excludes mock token rows by default and allows an explicit mock query', () => {
    const defaults = buildSelectAgentTokenUsageSql({})
    assert.match(defaults.sql, /"model" NOT IN/)
    assert.deepEqual(defaults.values, ['mock'])

    const mockOnly = buildSelectAgentTokenUsageSql({ model: 'mock' })
    assert.doesNotMatch(mockOnly.sql, /NOT IN/)
    assert.match(mockOnly.sql, /"model" =/)
    assert.deepEqual(mockOnly.values, ['mock'])
  })
})
