import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { loadOverviewSnapshot, type OverviewDb } from './overview.service.js'
import type { AgentActivitySurface } from '../../../../../src/agent/activity-surface.js'
import type { OverviewToolActivityInput } from './overview-tool-log.js'

const now = new Date('2026-07-20T08:00:00.000Z')

function createFakeDb(focus: unknown): OverviewDb {
  return {
    botAgentLedgerEntry: {
      async count() {
        return 12
      },
      async findFirst() {
        return {
          id: 42n,
          entryType: 'compaction',
          createdAt: new Date('2026-07-20T07:55:00.000Z'),
        }
      },
    },
    botAgentRuntimeState: {
      async findUnique() {
        return {
          qqConversationFocus: focus,
          lastWakeAt: new Date('2026-07-20T07:59:00.000Z'),
          updatedAt: new Date('2026-07-20T07:59:30.000Z'),
        }
      },
    },
    botAgentGoal: {
      async findUnique() {
        return {
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
          updatedAt: new Date('2026-07-20T07:58:00.000Z'),
        }
      },
    },
    agentTokenUsage: {
      async findFirst() {
        return {
          ts: new Date('2026-07-20T07:57:00.000Z'),
          model: 'test-model',
          inputTokens: 100,
          cachedTokens: 75,
          outputTokens: 20,
          cacheHitRate: null,
        }
      },
    },
  }
}

const toolActivity: OverviewToolActivityInput = {
  calls24h: 9,
  failed24h: 2,
  warnings: [],
  recentCalls: [
    {
      ts: '2026-07-20T07:59:50.000Z',
      toolCallId: 'call-3',
      toolName: 'web_search',
      roundIndex: 7,
      argsSummary: { query: 'BTC 下跌原因' },
      durationMs: 5_182,
      ok: true,
      sideEffect: false,
    },
    {
      ts: '2026-07-20T07:59:40.000Z',
      toolCallId: 'call-2',
      toolName: 'inbox',
      roundIndex: 7,
      argsSummary: { action: 'read' },
      durationMs: 120,
      ok: true,
      sideEffect: false,
    },
  ],
}

const activity: AgentActivitySurface = {
  schemaVersion: 1,
  instanceId: 'instance-1',
  pid: 123,
  startedAt: '2026-07-20T07:50:00.000Z',
  generatedAt: '2026-07-20T07:59:59.000Z',
  phase: 'tool',
  phaseStartedAt: '2026-07-20T07:59:55.000Z',
  roundIndex: 8,
  detail: '正在执行 browser',
  waitUntil: null,
  trigger: {
    kind: 'private_message',
    label: '收到 Alice 的私聊',
    target: { type: 'private', id: '42' },
  },
  activeTools: [{
    toolCallId: 'call-live',
    toolName: 'browser',
    roundIndex: 8,
    startedAt: '2026-07-20T07:59:55.000Z',
    argsSummary: { action: 'open', url: 'https://example.com' },
  }],
  lastCompleted: null,
}

describe('loadOverviewSnapshot', () => {
  test('serializes a read-only overview snapshot from the query port', async () => {
    const result = await loadOverviewSnapshot(
      createFakeDb({ type: 'group', groupId: 123 }),
      now,
      { status: 'available', surface: activity },
      toolActivity,
    )

    assert.equal(result.ledger.entryCount, 12)
    assert.equal(result.ledger.headEntryId, '42')
    assert.equal(result.ledger.latestEntryType, 'compaction')
    assert.deepEqual(result.runtime.focus, { type: 'group', id: '123' })
    assert.equal(result.goal?.objective, '建立只读 WebAdmin')
    assert.equal(result.goal?.currentCommitment?.action, '建立当前活动观察面')
    assert.equal(result.activity.phase, 'tool')
    assert.equal(result.activity.activeTools[0]?.toolName, 'browser')
    assert.equal(result.recentActions[0]?.title, '搜索了网络信息')
    assert.equal(result.recentActions[0]?.id, 'call-3')
    assert.equal(result.recentActions[1]?.title, '读取了消息')
    assert.equal(result.latestAgentUsage?.cacheHitRate, 0.75)
    assert.deepEqual(result.tools24h, { calls: 9, failed: 2 })
    assert.equal(result.generatedAt, '2026-07-20T08:00:00.000Z')
    assert.equal(result.readOnly, true)
    assert.deepEqual(result.warnings, [])
  })

  test('drops an invalid runtime focus and reports a warning', async () => {
    const result = await loadOverviewSnapshot(
      createFakeDb({ type: 'group', groupId: 'bad' }),
      now,
      { status: 'missing' },
      { ...toolActivity, warnings: ['工具审计模式为 side_effects；最近进展只包含副作用调用。'] },
    )

    assert.equal(result.runtime.focus, null)
    assert.equal(result.activity.phase, 'unavailable')
    assert.ok(result.warnings.includes('runtime.qqConversationFocus invalid'))
    assert.ok(result.warnings.includes('工具审计模式为 side_effects；最近进展只包含副作用调用。'))
  })
})
