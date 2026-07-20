import assert from 'node:assert/strict'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, test } from 'vitest'
import type { OverviewSnapshot } from './overview.schema.js'
import { OverviewView } from './OverviewView.js'

const snapshot: OverviewSnapshot = {
  schemaVersion: 1,
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
    updatedAt: '2026-07-20T07:58:00.000Z',
  },
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

    assert.ok(screen.getByText('只读模式'))
    assert.ok(screen.getByText('Ledger entries'))
    assert.ok(screen.getByText('12'))
    assert.ok(screen.getByText('Head #42'))
    assert.ok(screen.getByText('群 123'))
    assert.ok(screen.getByText('建立只读 WebAdmin'))
    assert.ok(screen.getByText('active'))
    assert.ok(screen.getByText('75.0%'))
    assert.ok(screen.getByText('2 / 9'))
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
        }}
        isRefreshing={false}
        refreshFailed={false}
      />,
    )

    assert.ok(screen.getByText('Runtime 状态缺失'))
    assert.ok(screen.getByText('暂无活跃 Goal'))
  })
})
