import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveDailyMetricDates, summarizeDailyAgentMetrics } from './agent-daily-metrics.js'

describe('agent daily metrics', () => {
  test('summarizes tokens and effective tool calls without rest-specific metrics', () => {
    const result = summarizeDailyAgentMetrics({
      tokenUsageNdjson: JSON.stringify({
        ts: '2026-07-13T09:00:00.000+08:00',
        operation: 'agent',
        model: 'real-model',
        inputTokens: 100,
        cachedTokens: 40,
        outputTokens: 20,
      }),
      appLogNdjson: [
        JSON.stringify({
          time: '2026-07-13T09:01:00.000+08:00',
          msg: 'round_llm_done',
          model: 'real-model',
          toolNames: ['invoke', 'yield'],
          effectiveToolNames: ['send_message', 'yield'],
        }),
        JSON.stringify({
          time: '2026-07-13T09:02:00.000+08:00',
          msg: 'rest_elapsed',
        }),
      ].join('\n'),
    }, { date: '2026-07-13', now: new Date('2026-07-13T03:00:00Z') })

    const report = result.reports[0]!
    assert.equal(report.tokenUsage.total.totalTokens, 120)
    assert.deepEqual(report.toolCalls.byTool, { send_message: 1, yield: 1 })
    assert.equal('rest' in report, false)
  })

  test('resolves a bounded Beijing date range', () => {
    assert.deepEqual(resolveDailyMetricDates({
      now: new Date('2026-07-13T03:00:00Z'),
      days: 2,
    }), ['2026-07-12', '2026-07-13'])
    assert.throws(() => resolveDailyMetricDates({ days: 32 }))
  })
})
