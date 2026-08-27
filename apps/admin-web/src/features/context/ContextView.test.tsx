// @vitest-environment jsdom

import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, test, vi } from 'vitest'
import { contextDemoSnapshot } from './context.demo.js'
import { contextSnapshotSchema, type ContextSnapshot } from './context.schema.js'
import { ContextView } from './ContextView.js'

const snapshot: ContextSnapshot = {
  schemaVersion: 5,
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
  test('loads archived thinking only when its collapsible cards are opened', async () => {
    const loadThinkingArchive = vi.fn(async () => ({
      schemaVersion: 1 as const,
      entries: [{
        entryId: '42',
        createdAt: '2026-07-26T07:59:39.000Z',
        blocks: [{ blockIndex: 0, type: 'thinking' as const, charCount: 9 }],
      }],
    }))
    const loadThinkingBlock = vi.fn(async (_input: { entryId: string; blockIndex: number }) => ({
      schemaVersion: 1 as const,
      entryId: '42',
      blockIndex: 0,
      type: 'thinking' as const,
      thinking: '先检查当前状态，再决定下一步。',
    }))

    render(<ContextView
      snapshot={snapshot}
      isRefreshing={false}
      refreshFailed={false}
      loadThinkingArchive={loadThinkingArchive}
      loadThinkingBlock={loadThinkingBlock}
    />)

    assert.equal(screen.queryByText('先检查当前状态，再决定下一步。'), null)
    fireEvent.click(screen.getByText('思考档案'))
    await waitFor(() => assert.equal(loadThinkingArchive.mock.calls.length, 1))

    const cardSummary = await screen.findByText('思考 #42 · 区块 1')
    assert.equal(loadThinkingBlock.mock.calls.length, 0)
    fireEvent.click(cardSummary)
    assert.ok(await screen.findByText('先检查当前状态，再决定下一步。'))
    assert.deepEqual(loadThinkingBlock.mock.calls[0]?.[0], { entryId: '42', blockIndex: 0 })

    fireEvent.click(cardSummary)
    fireEvent.click(cardSummary)
    await waitFor(() => assert.equal(loadThinkingBlock.mock.calls.length, 1))
  })

  test('reveals a large thinking archive in iPad-friendly batches', async () => {
    const entries = Array.from({ length: 41 }, (_, index) => ({
      entryId: String(100 - index),
      createdAt: '2026-07-26T07:59:39.000Z',
      blocks: [{ blockIndex: 0, type: 'thinking' as const, charCount: 9 }],
    }))
    render(<ContextView
      snapshot={snapshot}
      isRefreshing={false}
      refreshFailed={false}
      loadThinkingArchive={async () => ({ schemaVersion: 1, entries })}
      loadThinkingBlock={async input => ({
        schemaVersion: 1,
        ...input,
        type: 'thinking',
        thinking: '正文',
      })}
    />)

    fireEvent.click(screen.getByText('思考档案'))
    assert.ok(await screen.findByText('思考 #61 · 区块 1'))
    assert.equal(screen.queryByText('思考 #60 · 区块 1'), null)
    fireEvent.click(screen.getByRole('button', { name: '显示更早的 1 个思考区块' }))
    assert.ok(await screen.findByText('思考 #60 · 区块 1'))
  })

  test('labels the in-memory example and renders a representative tool round', () => {
    assert.doesNotThrow(() => contextSnapshotSchema.parse(contextDemoSnapshot))
    render(<ContextView
      snapshot={contextDemoSnapshot}
      isRefreshing={false}
      refreshFailed={false}
      isDemo
    />)

    assert.ok(screen.getByRole('heading', { level: 1, name: 'Agent 历史 · 示例' }))
    assert.ok(screen.getByText('示例数据，不是实际运行记录'))
    const userMessage = screen.getByRole('article', { name: '用户消息 #121' })
    assert.ok(within(userMessage).getByText('帮我看看 Luna 最近在忙什么，给我一个简短的进展摘要。', { selector: 'p' }))
    assert.ok(screen.getByRole('article', { name: '工具调用 memory_search · 成功' }))
    assert.ok(screen.getByRole('link', { name: '返回真实数据' }))
  })

  test('rebuilds the canonical history as a chronological conversation after refresh', () => {
    render(<ContextView
      snapshot={{
        ...snapshot,
        entries: [compactionEntry(), userEntry(), assistantEntry(), toolEntry()],
      }}
      isRefreshing={false}
      refreshFailed={false}
    />)

    const transcript = screen.getByRole('log', { name: 'Agent canonical 历史' })
    assert.ok(within(transcript).getByText('会话已压缩'))
    assert.ok(within(transcript).getByText('请检查最新状态'))
    assert.ok(within(transcript).getByRole('heading', { level: 2, name: '检查完成' }))
    assert.ok(within(transcript).getByRole('article', { name: '工具调用 web_search · 成功' }))
    assert.ok(within(transcript).getByText('找到 3 条结果', { selector: '.agent-tool-result p' }))
    assert.ok(screen.getByText('Ledger 技术信息'))

    const text = transcript.textContent ?? ''
    assert.ok(text.indexOf('会话已压缩') < text.indexOf('请检查最新状态'))
    assert.ok(text.indexOf('请检查最新状态') < text.indexOf('检查完成'))
    assert.equal(screen.queryByText('最近 80 条 canonical entries'), null)
  })

  test('keeps effective tool, key parameters, status, and result visible as an action chain', () => {
    render(<ContextView
      snapshot={{
        ...snapshot,
        entries: [assistantInvokeEntry(), invokeResultEntry()],
      }}
      isRefreshing={false}
      refreshFailed={false}
    />)

    const action = screen.getByRole('region', { name: 'Agent 动作 #44' })
    const actionMessage = screen.getByRole('article', { name: 'Main Agent 消息 #44' })
    assert.ok(within(action).getByText('conversation'))
    assert.ok(within(action).getByText('通过 invoke'))
    assert.ok(within(action).getByText('action'))
    assert.ok(within(action).getByText('open'))
    assert.ok(within(action).getByText('target'))
    assert.ok(within(action).getByText('QQ 私聊 · 3999414673'))
    assert.ok(within(action).getByText('已打开 QQ 私聊 3999414673', { selector: '.agent-tool-result p' }))
    assert.ok(within(action).getByText('成功'))
    assert.equal(within(action).queryByText('处理详情'), null)
    assert.equal(within(actionMessage).queryByText('Agent 动作'), null)
  })

  test('summarizes visible tool activity before the transcript', () => {
    render(<ContextView
      snapshot={{
        ...snapshot,
        entries: [assistantEntry(), toolEntry(), assistantInvokeEntry(), invokeResultEntry()],
      }}
      isRefreshing={false}
      refreshFailed={false}
    />)

    assert.ok(screen.getByRole('heading', { level: 1, name: 'Agent 历史' }))
    assert.ok(screen.getByRole('heading', { level: 2, name: '正式对话与动作' }))
    const definition = screen.getByRole('complementary', { name: 'Agent 历史说明' })
    assert.ok(definition.textContent?.includes('正式历史'))
    assert.ok(definition.textContent?.includes('下一轮与重启后'))
    assert.equal(screen.getByRole('link', { name: '排查执行过程' }).getAttribute('href'), '/timeline')
    const summary = screen.getByLabelText('Agent 历史摘要')
    assert.ok(within(summary).getByLabelText('2 次工具调用'))
    assert.ok(within(summary).getByLabelText('0 次失败'))
    assert.ok(within(summary).getByLabelText('0 次未返回'))

    const tools = within(summary).getByLabelText('工具使用统计')
    assert.ok(within(tools).getByLabelText('conversation 1 次'))
    assert.ok(within(tools).getByLabelText('web_search 1 次'))
  })

  test('compresses a canonical notification into a readable event card', () => {
    render(<ContextView
      snapshot={{
        ...snapshot,
        entries: [notificationEntry()],
      }}
      isRefreshing={false}
      refreshFailed={false}
    />)

    const event = screen.getByRole('article', { name: '系统通知 #69' })
    assert.ok(within(event).getByText('QQ inbox_update'))
    assert.ok(within(event).getByText('QQ 私聊 · 714457117'))
    assert.ok(within(event).getByText('1 条新消息'))
    assert.ok(within(event).getByText('查看完整事件'))
    assert.equal(within(event).queryByText(/\{"event":"notification"/, { selector: '.agent-markdown p' }), null)
  })
})

function compactionEntry(): ContextSnapshot['entries'][number] {
  return {
    kind: 'compaction', id: '40', entryType: 'compaction', createdAt: '2026-07-26T07:50:00.000Z', role: null,
    summary: '## 历史摘要\n保留最近一次工具回合。', reason: 'threshold', firstKeptEntryId: '30',
    tokensBefore: 12_000, estimatedTokensAfter: 4_000, isSplitTurn: false, rawPreview: '{}',
  }
}

function userEntry(): ContextSnapshot['entries'][number] {
  return {
    kind: 'message', id: '41', entryType: 'message', createdAt: '2026-07-26T07:58:00.000Z', role: 'user',
    summary: '请检查最新状态', toolCalls: [], toolCallId: null, toolName: null, parentEntryId: null, result: null, rawPreview: '{}',
  }
}

function assistantEntry(): ContextSnapshot['entries'][number] {
  return {
    kind: 'message', id: '42', entryType: 'message', createdAt: '2026-07-26T07:59:39.000Z', role: 'assistant',
    summary: '## 检查完成\n\n状态正常。',
    toolCalls: [{
      id: 'call-search', name: 'web_search', displayName: 'web_search', transportName: null,
      argsPreview: '{\n  "query": "状态"\n}', parameters: [{ label: 'query', value: '状态' }],
    }],
    toolCallId: null, toolName: null, parentEntryId: null, result: null, rawPreview: '{}',
  }
}

function assistantInvokeEntry(): ContextSnapshot['entries'][number] {
  return {
    kind: 'message', id: '44', entryType: 'message', createdAt: '2026-07-26T08:01:00.000Z', role: 'assistant',
    summary: '',
    toolCalls: [{
      id: 'call-open', name: 'invoke', displayName: 'conversation', transportName: 'invoke',
      argsPreview: '{\n  "action": "open",\n  "target": {\n    "kind": "private",\n    "platform": "qq",\n    "accountId": "10000",\n    "externalId": "3999414673"\n  }\n}',
      parameters: [
        { label: 'action', value: 'open' },
        { label: 'target', value: 'QQ 私聊 · 3999414673' },
      ],
    }],
    toolCallId: null, toolName: null, parentEntryId: null, result: null, rawPreview: '{}',
  }
}

function invokeResultEntry(): ContextSnapshot['entries'][number] {
  return {
    kind: 'message', id: '45', entryType: 'message', createdAt: '2026-07-26T08:01:01.000Z', role: 'tool',
    summary: '已打开 QQ 私聊 3999414673', toolCalls: [], toolCallId: 'call-open', toolName: 'invoke', parentEntryId: '44',
    result: { ok: true, status: 'succeeded', code: null, reason: null }, rawPreview: '{}',
  }
}

function toolEntry(): ContextSnapshot['entries'][number] {
  return {
    kind: 'message', id: '43', entryType: 'message', createdAt: '2026-07-26T07:59:40.000Z', role: 'tool',
    summary: '找到 3 条结果', toolCalls: [], toolCallId: 'call-search', toolName: 'web_search', parentEntryId: '42',
    result: { ok: true, status: 'succeeded', code: null, reason: null }, rawPreview: '{}',
  }
}

function notificationEntry(): ContextSnapshot['entries'][number] {
  return {
    kind: 'message', id: '69', entryType: 'message', createdAt: '2026-08-23T09:13:43.000Z', role: 'user',
    summary: JSON.stringify({
      event: 'notification',
      id: 'qq:qq:3999414673:private:714457117:250',
      source: { type: 'qq', mailbox: 'qq:3999414673:private:714457117' },
      kind: 'inbox_update',
      delivery: 'interrupt',
      count: 1,
      data: {
        conversation: { platform: 'qq', accountId: '3999414673', kind: 'private', externalId: '714457117' },
      },
    }),
    toolCalls: [], toolCallId: null, toolName: null, parentEntryId: null, result: null, rawPreview: '{}',
  }
}
