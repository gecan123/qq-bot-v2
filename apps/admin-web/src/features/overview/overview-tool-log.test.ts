import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { parseOverviewToolLog, summarizeOverviewToolLog } from './overview-tool-log.js'

function line(input: {
  ts: string
  toolCallId: string
  ok?: boolean
  toolName?: string
}) {
  return JSON.stringify({
    ts: input.ts,
    toolCallId: input.toolCallId,
    toolName: input.toolName ?? 'inbox',
    roundIndex: 1,
    argsSummary: { action: 'read' },
    durationMs: 12,
    ok: input.ok ?? true,
    sideEffect: false,
  })
}

describe('overview tool log', () => {
  test('sorts recent calls and computes the rolling 24 hour summary', () => {
    const parsed = parseOverviewToolLog([
      line({ ts: '2026-07-19T07:59:59.000Z', toolCallId: 'old' }),
      line({ ts: '2026-07-20T07:30:00.000Z', toolCallId: 'newer', ok: false, toolName: 'web_search' }),
      line({ ts: '2026-07-20T06:30:00.000Z', toolCallId: 'new' }),
      line({ ts: '2026-07-20T08:00:01.000Z', toolCallId: 'future' }),
    ].join('\n'))

    const result = summarizeOverviewToolLog(parsed, new Date('2026-07-20T08:00:00.000Z'))

    assert.deepEqual(result.recentCalls.map(entry => entry.toolCallId), [
      'future',
      'newer',
      'new',
      'old',
    ])
    assert.equal(result.calls24h, 2)
    assert.equal(result.failed24h, 1)
    assert.deepEqual(result.warnings, [])
  })

  test('keeps only sixteen recent valid records and reports malformed lines', () => {
    const validLines = Array.from({ length: 18 }, (_, index) => line({
      ts: `2026-07-20T07:${String(index).padStart(2, '0')}:00.000Z`,
      toolCallId: `call-${index}`,
    }))
    const parsed = parseOverviewToolLog([...validLines, '{bad json', '{"ts":"invalid"}'].join('\n'))

    const result = summarizeOverviewToolLog(
      parsed,
      new Date('2026-07-20T08:00:00.000Z'),
      ['工具审计模式为 side_effects；最近进展只包含副作用调用。'],
    )

    assert.equal(result.recentCalls.length, 16)
    assert.equal(result.recentCalls[0]?.toolCallId, 'call-17')
    assert.equal(result.calls24h, 18)
    assert.deepEqual(result.warnings, [
      '工具审计模式为 side_effects；最近进展只包含副作用调用。',
      '工具审计日志包含 2 条无效记录，已跳过。',
    ])
  })
})
