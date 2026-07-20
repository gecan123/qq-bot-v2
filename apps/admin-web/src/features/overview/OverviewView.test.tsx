import assert from 'node:assert/strict'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, test } from 'vitest'
import type { OverviewSnapshot } from './overview.schema.js'
import { OverviewView } from './OverviewView.js'

const snapshot: OverviewSnapshot = {
  schemaVersion: 2,
  generatedAt: '2026-07-20T08:00:00.000Z',
  readOnly: true,
  ledger: {
    entryCount: 12,
    headEntryId: '42',
    latestEntryType: 'compaction',
    latestEntryAt: '2026-07-20T07:55:00.000Z',
  },
  runtime: {
    available: true,
    updatedAt: '2026-07-20T07:59:30.000Z',
    lastWakeAt: '2026-07-20T07:59:00.000Z',
    focus: { type: 'group', id: '123' },
  },
  goal: {
    goalId: '550e8400-e29b-41d4-a716-446655440000',
    objective: '建立只读 WebAdmin',
    status: 'active',
    tokensUsed: 800,
    tokenBudget: 10_000,
    revision: 3,
    currentCommitment: {
      action: '建立当前活动观察面',
      reason: '让管理员一眼看懂 Agent 在做什么',
      expectedEvidence: '首页显示实时 phase 和最近进展',
    },
    updatedAt: '2026-07-20T07:58:00.000Z',
  },
  activity: {
    available: true,
    sourceStatus: 'available',
    phase: 'tool',
    phaseStartedAt: '2026-07-20T07:59:55.000Z',
    roundIndex: 8,
    detail: '正在执行 browser',
    waitUntil: null,
    trigger: { kind: 'private_message', label: '收到 Alice 的私聊', target: { type: 'private', id: '42' } },
    activeTools: [{ toolCallId: 'call-live', toolName: 'browser', roundIndex: 8, startedAt: '2026-07-20T07:59:55.000Z', argsSummary: { action: 'open' } }],
    lastCompleted: null,
  },
  recentActions: [{
    id: '3',
    at: '2026-07-20T07:59:50.000Z',
    title: '搜索了网络信息',
    detail: '关键词：BTC 下跌原因',
    ok: true,
    durationMs: 5_182,
    sideEffect: false,
    toolName: 'web_search',
    toolCallId: 'call-3',
    roundIndex: 7,
    argsSummary: { query: 'BTC 下跌原因' },
  }],
  latestAgentUsage: {
    ts: '2026-07-20T07:57:00.000Z',
    model: 'test-model',
    inputTokens: 100,
    cachedTokens: 75,
    outputTokens: 20,
    cacheHitRate: 0.75,
  },
  tools24h: { calls: 9, failed: 2 },
  warnings: [],
}

afterEach(cleanup)

describe('OverviewView', () => {
  test('renders the read-only operational snapshot', () => {
    render(<OverviewView snapshot={snapshot} isRefreshing={false} refreshFailed={false} />)

    assert.ok(screen.getByText('正在使用工具'))
    assert.ok(screen.getByText('建立当前活动观察面'))
    assert.ok(screen.getByText('收到 Alice 的私聊'))
    assert.ok(screen.getByText('搜索了网络信息'))
    assert.ok(screen.getByText('Ledger'))
    assert.ok(screen.getByText('12'))
    assert.ok(screen.getByText('Head #42 · compaction'))
    assert.ok(screen.getByText('群 123'))
    assert.ok(screen.getByText('建立只读 WebAdmin'))
    assert.ok(screen.getByText('active'))
    assert.ok(screen.getByText('75.0%'))
    assert.ok(screen.getByText('2 failed'))
  })

  test('renders explicit empty runtime and Goal states', () => {
    render(
      <OverviewView
        snapshot={{
          ...snapshot,
          runtime: {
            available: false,
            updatedAt: null,
            lastWakeAt: null,
            focus: null,
          },
          goal: null,
          latestAgentUsage: null,
          activity: {
            available: false,
            sourceStatus: 'missing',
            phase: 'unavailable',
            phaseStartedAt: null,
            roundIndex: null,
            detail: null,
            waitUntil: null,
            trigger: null,
            activeTools: [],
            lastCompleted: null,
          },
          recentActions: [],
        }}
        isRefreshing={false}
        refreshFailed={false}
      />,
    )

    assert.ok(screen.getByText('Runtime 状态缺失'))
    assert.ok(screen.getByText('暂无持久 Goal'))
    assert.ok(screen.getByText('实时状态不可用'))
  })
})
