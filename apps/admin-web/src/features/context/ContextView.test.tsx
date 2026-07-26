// @vitest-environment jsdom

import assert from 'node:assert/strict'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, test } from 'vitest'
import type { ContextSnapshot } from './context.schema.js'
import { ContextView } from './ContextView.js'

const snapshot: ContextSnapshot = {
  schemaVersion: 2,
  generatedAt: '2026-07-26T08:00:00.000Z',
  ledger: {
    total: 12,
    headId: '42',
    checkpointThroughId: '40',
    checkpointUpdatedAt: '2026-07-26T07:58:00.000Z',
    typeCounts: [{ type: 'message', count: 12 }],
  },
  runtime: {
    ledgerHeadId: '42',
    goalRevision: 3,
    updatedAt: '2026-07-26T07:59:00.000Z',
  },
  latestUsage: {
    ts: '2026-07-26T07:59:30.000Z',
    model: 'claude-test',
    inputTokens: 100,
    cachedTokens: 80,
    outputTokens: 12,
    cacheHitRate: 0.8,
  },
  recentLlmCalls: [{
    callId: '11111111-1111-4111-8111-111111111111',
    ts: '2026-07-26T07:59:30.000Z',
    operation: 'agent.chat',
    actor: 'main_agent',
    provider: 'claude-code',
    model: 'claude-test',
    status: 'succeeded',
    durationMs: 125,
    stopReason: 'tool_use',
    errorKind: null,
    inputTokens: 100,
    cachedTokens: 80,
    outputTokens: 12,
    evidence: {
      canonicalRequest: { fingerprint: 'a'.repeat(64), toolNames: ['inbox'] },
      providerRequest: { fingerprint: 'b'.repeat(64), toolNames: ['inbox'] },
      providerResponse: { fingerprint: 'c'.repeat(64), toolNames: ['inbox'] },
      canonicalResponse: { fingerprint: 'd'.repeat(64), toolNames: ['inbox'] },
    },
  }, {
    callId: '22222222-2222-4222-8222-222222222222',
    ts: '2026-07-26T07:58:30.000Z',
    operation: 'goal.completion_judge',
    actor: 'goal_judge',
    provider: 'openai-agent',
    model: 'gpt-test',
    status: 'failed',
    durationMs: 2_000,
    stopReason: null,
    errorKind: 'server',
    inputTokens: null,
    cachedTokens: null,
    outputTokens: null,
    evidence: null,
  }],
  entries: [],
  warnings: [],
}

afterEach(cleanup)

describe('ContextView LLM calls', () => {
  test('shows recent provider traces without rendering prompt or response bodies', () => {
    render(<ContextView snapshot={snapshot} isRefreshing={false} refreshFailed={false} />)

    assert.ok(screen.getByText('最近 LLM 调用'))
    assert.ok(screen.getByText('agent.chat'))
    assert.ok(screen.getByText('goal.completion_judge'))
    assert.ok(screen.getByText('claude-code · claude-test'))
    assert.ok(screen.getByText('server'))
    assert.ok(screen.getAllByText('inbox').length >= 1)
    assert.equal(screen.queryByText(/prompt body|response body/), null)
  })
})
