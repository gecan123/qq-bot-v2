// @vitest-environment jsdom

import assert from 'node:assert/strict'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, test } from 'vitest'
import type { ContextSnapshot } from './context.schema.js'
import { ContextView } from './ContextView.js'

const snapshot: ContextSnapshot = {
  schemaVersion: 3,
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

describe('ContextView ledger entries', () => {
  test('shows the message role as the primary meaning and keeps raw payload available on demand', () => {
    render(<ContextView
      snapshot={{
        ...snapshot,
        entries: [{
          kind: 'message',
          id: '43',
          entryType: 'message',
          createdAt: '2026-07-26T07:59:40.000Z',
          role: 'tool',
          summary: '已完成当前动作，等待新输入。',
          toolCalls: [],
          toolCallId: 'call-yield',
          toolName: 'yield',
          parentEntryId: '42',
          result: {
            ok: true,
            status: 'yielded',
            code: null,
            reason: '已完成当前动作，等待新输入。',
          },
          rawPreview: JSON.stringify({
            schemaVersion: 1,
            message: {
              role: 'tool',
              toolCallId: 'call-yield',
              content: JSON.stringify({
                ok: true,
                status: 'yielded',
                reason: '已完成当前动作，等待新输入。',
              }),
            },
          }),
        }],
      }}
      isRefreshing={false}
      refreshFailed={false}
    />)

    assert.ok(screen.getByText('工具结果'))
    assert.ok(screen.getByText('Ledger: message'))
    assert.ok(screen.getByText('查看原始 JSON'))
  })

  test('renders assistant and tool entries as one readable turn and summarizes compaction', () => {
    render(<ContextView
      snapshot={{
        ...snapshot,
        entries: [{
          kind: 'message',
          id: '42',
          entryType: 'message',
          createdAt: '2026-07-26T07:59:39.000Z',
          role: 'assistant',
          summary: '',
          toolCalls: [{ id: 'call-yield', name: 'yield' }],
          toolCallId: null,
          toolName: null,
          parentEntryId: null,
          result: null,
          rawPreview: '{}',
        }, {
          kind: 'message',
          id: '43',
          entryType: 'message',
          createdAt: '2026-07-26T07:59:40.000Z',
          role: 'tool',
          summary: '已完成当前动作，等待新输入。',
          toolCalls: [],
          toolCallId: 'call-yield',
          toolName: 'yield',
          parentEntryId: '42',
          result: {
            ok: true,
            status: 'yielded',
            code: null,
            reason: '已完成当前动作，等待新输入。',
          },
          rawPreview: '{}',
        }, {
          kind: 'compaction',
          id: '41',
          entryType: 'compaction',
          createdAt: '2026-07-26T07:50:00.000Z',
          role: null,
          summary: '保留最近一次工具回合。',
          reason: 'threshold',
          firstKeptEntryId: '30',
          tokensBefore: 12_000,
          estimatedTokensAfter: 4_000,
          isSplitTurn: false,
          rawPreview: '{}',
        }],
      }}
      isRefreshing={false}
      refreshFailed={false}
    />)

    assert.ok(screen.getByText('Agent 工具请求'))
    assert.ok(screen.getAllByText('yield').length >= 1)
    assert.ok(screen.getByText('已完成当前动作，等待新输入。'))
    assert.ok(screen.getByText('关联调用 #42'))
    assert.ok(screen.getByText('压缩边界'))
    assert.ok(screen.getByText('threshold · 12,000 → 4,000 tokens'))
    assert.ok(screen.getByText('保留最近一次工具回合。'))
  })
})
