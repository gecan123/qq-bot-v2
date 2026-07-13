import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveDailyMetricDates, summarizeDailyAgentMetrics } from './agent-daily-metrics.js'

describe('agent daily metrics', () => {
  test('uses Beijing calendar days and returns one bucket per natural day', () => {
    assert.deepEqual(resolveDailyMetricDates({
      days: 3,
      now: new Date('2026-07-13T15:30:00.000Z'),
    }), ['2026-07-11', '2026-07-12', '2026-07-13'])

    assert.deepEqual(resolveDailyMetricDates({
      endOffsetDays: -1,
      now: new Date('2026-07-13T15:30:00.000Z'),
    }), ['2026-07-12'])
  })

  test('excludes mock usage and counts effective invoke targets without double counting', () => {
    const result = summarizeDailyAgentMetrics({
      tokenUsageNdjson: [
        JSON.stringify({
          ts: '2026-07-13T00:00:00.000+08:00',
          operation: 'agent.chat',
          model: 'LongCat-2.0',
          inputTokens: 100,
          cachedTokens: 80,
          outputTokens: 20,
        }),
        JSON.stringify({
          ts: '2026-07-13T12:00:00.000+08:00',
          operation: 'life_journal.review',
          model: 'LongCat-2.0',
          inputTokens: 50,
          cachedTokens: 0,
          outputTokens: 5,
        }),
        JSON.stringify({
          ts: '2026-07-13T12:00:00.000+08:00',
          operation: 'agent.chat',
          model: 'mock',
          inputTokens: 999,
          cachedTokens: 999,
          outputTokens: 999,
        }),
        JSON.stringify({
          ts: '2026-07-14T00:00:00.000+08:00',
          operation: 'agent.chat',
          model: 'LongCat-2.0',
          inputTokens: 777,
          cachedTokens: 0,
          outputTokens: 7,
        }),
      ].join('\n'),
      appLogNdjson: [
        JSON.stringify({
          time: '2026-07-13T00:00:00.000+08:00',
          msg: 'round_llm_done',
          model: 'LongCat-2.0',
          toolNames: ['pause', 'invoke'],
        }),
        JSON.stringify({
          time: '2026-07-13T08:00:00.000+08:00',
          msg: 'round_llm_done',
          model: 'LongCat-2.0',
          toolNames: ['invoke'],
          effectiveToolNames: ['browser'],
        }),
        JSON.stringify({
          time: '2026-07-13T09:00:00.000+08:00',
          msg: 'rest_enter',
          durationSeconds: 300,
          confirmed: true,
          reason: 'SOL 观察告一段落，等 zzz 回复',
        }),
        JSON.stringify({
          time: '2026-07-13T09:05:00.000+08:00',
          msg: 'rest_elapsed',
        }),
        JSON.stringify({
          time: '2026-07-13T10:00:00.000+08:00',
          msg: 'rest_redirected',
          reason: '想短暂放空',
        }),
        JSON.stringify({
          time: '2026-07-13 12:00:00',
          msg: 'round_llm_done',
          model: 'LongCat-2.0',
          toolNames: ['send_message'],
        }),
        JSON.stringify({
          time: '2026-07-13 12:00:01',
          msg: 'round_tool_done',
          toolName: 'send_message',
          ok: true,
        }),
        JSON.stringify({
          time: '2026-07-13T12:00:00.000+08:00',
          msg: 'round_llm_done',
          model: 'mock',
          toolNames: ['boom'],
        }),
      ].join('\n'),
    }, {
      date: '2026-07-13',
      now: new Date('2026-07-13T15:30:00.000Z'),
    })

    assert.equal(result.reports.length, 1)
    const report = result.reports[0]!
    assert.equal(report.from, '2026-07-13T00:00:00.000+08:00')
    assert.equal(report.toExclusive, '2026-07-14T00:00:00.000+08:00')
    assert.deepEqual(report.tokenUsage.total, {
      entries: 2,
      inputTokens: 150,
      cachedTokens: 80,
      outputTokens: 25,
      totalTokens: 175,
      uncachedInputTokens: 70,
      uncachedPlusOutputTokens: 95,
      cacheHitRate: 0.5333,
    })
    assert.deepEqual(report.toolCalls, {
      rounds: 3,
      total: 4,
      byTool: {
        browser: 1,
        invoke: 1,
        pause: 1,
        send_message: 1,
      },
      unresolvedInvokeCalls: 1,
    })
    assert.deepEqual(report.rest, {
      requests: 2,
      started: 1,
      redirected: 1,
      confirmationRejected: 0,
      confirmed: 1,
      elapsed: 1,
      interrupted: 0,
      requestedSeconds: {
        total: 300,
        average: 300,
        max: 300,
      },
      reasons: {
        waitingForPersonOrMessage: 1,
        completion: 1,
        timeOfDay: 0,
        marketPolling: 1,
        other: 1,
      },
      postRest: {
        observed: 1,
        acted: 1,
        restedAgain: 0,
        unknown: 0,
      },
    })
  })

  test('rejects invalid calendar dates and oversized ranges', () => {
    assert.throws(() => resolveDailyMetricDates({ date: '2026-02-30' }), /invalid date/)
    assert.throws(() => resolveDailyMetricDates({ days: 32 }), /between 1 and 31/)
  })

  test('keeps old post-rest behavior unknown without tool completion evidence', () => {
    const result = summarizeDailyAgentMetrics({
      tokenUsageNdjson: '',
      appLogNdjson: [
        JSON.stringify({ time: '2026-07-13T09:00:00.000+08:00', msg: 'rest_elapsed' }),
        JSON.stringify({
          time: '2026-07-13T09:01:00.000+08:00',
          msg: 'round_llm_done',
          model: 'LongCat-2.0',
          toolNames: ['send_message'],
        }),
        JSON.stringify({
          time: '2026-07-13T09:02:00.000+08:00',
          msg: 'rest_enter',
          durationSeconds: 60,
          reason: '旧日志没有工具完成事件',
        }),
      ].join('\n'),
    }, { date: '2026-07-13' })

    assert.deepEqual(result.reports[0]!.rest.postRest, {
      observed: 1,
      acted: 0,
      restedAgain: 0,
      unknown: 1,
    })
  })
})
