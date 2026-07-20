import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { summarizeAgentMetrics } from './agent-metrics.js'

describe('summarizeAgentMetrics', () => {
  test('summarizes token usage and tool-call health from ndjson lines', () => {
    const result = summarizeAgentMetrics({
      tokenUsageNdjson: [
        '{"operation":"agent.chat","inputTokens":100,"cachedTokens":80,"outputTokens":20,"cacheHitRate":0.8}',
        '{"operation":"agent.chat","inputTokens":50,"cachedTokens":0,"outputTokens":10}',
        '{"operation":"compaction","inputTokens":200,"cachedTokens":null,"outputTokens":30}',
      ].join('\n'),
      toolCallsNdjson: [
        '{"toolName":"send_message","ok":true,"sideEffect":true,"durationMs":120}',
        '{"toolName":"fetch_url","ok":false,"sideEffect":false,"durationMs":500,"error":"timeout"}',
        '{"toolName":"fetch_url","ok":true,"sideEffect":false,"durationMs":250}',
        '{"toolName":"workspace_bash","ok":true,"sideEffect":false,"durationMs":100}',
        '{"toolName":"workspace_bash","ok":true,"sideEffect":true,"durationMs":300}',
      ].join('\n'),
      appLogNdjson: [
        '{"time":"2026-07-11 10:00:00","scope":"INBOX","groupId":253631878,"returnedMessages":20,"msg":"inbox_group_read_completed"}',
        '{"time":"2026-07-11 10:01:00","scope":"TOOL_POLICY_HOOKS","targetType":"group","groupId":253631878,"decision":"blocked","msg":"send_message_ai_tone_precheck"}',
        '{"time":"2026-07-11 10:02:00","scope":"TOOL_POLICY_HOOKS","targetType":"group","groupId":253631878,"decision":"allowed","msg":"send_message_ai_tone_precheck"}',
        '{"time":"2026-07-11 10:02:01","scope":"SEND","direction":"outbound","targetType":"group","groupId":253631878,"mode":"ambient","deliveryResult":"sent","msg":"消息发送成功"}',
      ].join('\n'),
    })

    assert.deepEqual(result.tokenUsage.total, {
      entries: 3,
      inputTokens: 350,
      cachedTokens: 80,
      outputTokens: 60,
      cacheHitRate: 0.229,
    })
    assert.deepEqual(result.tokenUsage.byOperation['agent.chat'], {
      entries: 2,
      inputTokens: 150,
      cachedTokens: 80,
      outputTokens: 30,
      cacheHitRate: 0.533,
    })
    assert.equal(result.toolCalls.total, 5)
    assert.equal(result.toolCalls.failed, 1)
    assert.equal(result.toolCalls.sideEffects, 2)
    assert.deepEqual(result.toolCalls.sideEffectsByTool, {
      send_message: 1,
      workspace_bash: 1,
    })
    assert.deepEqual(result.toolCalls.byTool.fetch_url, {
      calls: 2,
      failed: 1,
      sideEffects: 0,
      avgDurationMs: 375,
      failedRate: 0.5,
      sideEffectRate: 0,
    })
    assert.deepEqual(result.toolCalls.byTool.workspace_bash, {
      calls: 2,
      failed: 0,
      sideEffects: 1,
      avgDurationMs: 200,
      failedRate: 0,
      sideEffectRate: 0.5,
    })
    assert.deepEqual(result.groupEngagement.byGroup['253631878'], {
      inboxReads: 1,
      messagesRead: 20,
      sendAttempts: 2,
      sendBlocked: 1,
      sendsSuccessful: 1,
      ambientSuccessful: 1,
      replySuccessful: 0,
      readToSendRate: 1,
    })
  })

  test('tracks malformed lines without throwing', () => {
    const result = summarizeAgentMetrics({
      tokenUsageNdjson: 'not-json\n{"operation":"agent.chat","inputTokens":10}',
      toolCallsNdjson: '{"toolName":"wait","ok":true}\n]',
    })

    assert.equal(result.malformedLines.tokenUsage, 1)
    assert.equal(result.malformedLines.toolCalls, 1)
    assert.equal(result.malformedLines.appLog, 0)
    assert.equal(result.tokenUsage.total.entries, 1)
    assert.equal(result.toolCalls.total, 1)
  })

  test('filters token usage and tool calls by time and dimensions', () => {
    const result = summarizeAgentMetrics({
      tokenUsageNdjson: [
        '{"ts":"2026-06-26T10:00:00.000Z","operation":"agent.chat","model":"gpt-5","inputTokens":100,"cachedTokens":50,"outputTokens":10}',
        '{"ts":"2026-06-26T11:00:00.000Z","operation":"compaction","model":"gpt-5","inputTokens":200,"cachedTokens":0,"outputTokens":20}',
        '{"ts":"2026-06-26T12:00:00.000Z","operation":"agent.chat","model":"gpt-4.1","inputTokens":300,"cachedTokens":150,"outputTokens":30}',
      ].join('\n'),
      toolCallsNdjson: [
        '{"ts":"2026-06-26T10:00:00.000Z","toolName":"fetch_url","ok":true,"sideEffect":false,"durationMs":100}',
        '{"ts":"2026-06-26T10:30:00.000Z","toolName":"fetch_url","ok":false,"sideEffect":false,"durationMs":200}',
        '{"ts":"2026-06-26T11:00:00.000Z","toolName":"send_message","ok":true,"sideEffect":true,"durationMs":300}',
      ].join('\n'),
    }, {
      from: new Date('2026-06-26T09:30:00.000Z'),
      to: new Date('2026-06-26T10:30:00.000Z'),
      operation: 'agent.chat',
      model: 'gpt-5',
      toolName: 'fetch_url',
      ok: true,
      sideEffect: false,
    })

    assert.deepEqual(result.tokenUsage.total, {
      entries: 1,
      inputTokens: 100,
      cachedTokens: 50,
      outputTokens: 10,
      cacheHitRate: 0.5,
    })
    assert.equal(result.toolCalls.total, 1)
    assert.deepEqual(result.toolCalls.byTool.fetch_url, {
      calls: 1,
      failed: 0,
      sideEffects: 0,
      avgDurationMs: 100,
      failedRate: 0,
      sideEffectRate: 0,
    })
  })

  test('excludes mock token usage by default but allows an explicit mock query', () => {
    const input = {
      tokenUsageNdjson: [
        '{"operation":"agent.chat","model":"mock","inputTokens":500000,"cachedTokens":0,"outputTokens":500000}',
        '{"operation":"agent.chat","model":"gpt-5","inputTokens":100,"cachedTokens":80,"outputTokens":20}',
      ].join('\n'),
      toolCallsNdjson: '',
    }

    const defaults = summarizeAgentMetrics(input)
    assert.deepEqual(defaults.tokenUsage.total, {
      entries: 1,
      inputTokens: 100,
      cachedTokens: 80,
      outputTokens: 20,
      cacheHitRate: 0.8,
    })

    const mockOnly = summarizeAgentMetrics(input, { model: 'mock' })
    assert.deepEqual(mockOnly.tokenUsage.total, {
      entries: 1,
      inputTokens: 500000,
      cachedTokens: 0,
      outputTokens: 500000,
      cacheHitRate: 0,
    })
  })
})
