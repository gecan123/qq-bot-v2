import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { loadOverviewSnapshot, type OverviewDb } from './overview.service.js'

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
    agentToolCall: {
      async count(input) {
        const where = (input as { where: Record<string, unknown> }).where
        return where.ok === false ? 2 : 9
      },
    },
  }
}

describe('loadOverviewSnapshot', () => {
  test('serializes a read-only overview snapshot from the query port', async () => {
    const result = await loadOverviewSnapshot(
      createFakeDb({ type: 'group', groupId: 123 }),
      now,
    )

    assert.equal(result.ledger.entryCount, 12)
    assert.equal(result.ledger.headEntryId, '42')
    assert.equal(result.ledger.latestEntryType, 'compaction')
    assert.deepEqual(result.runtime.focus, { type: 'group', id: '123' })
    assert.equal(result.goal?.objective, '建立只读 WebAdmin')
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
    )

    assert.equal(result.runtime.focus, null)
    assert.ok(result.warnings.includes('runtime.qqConversationFocus invalid'))
  })
})
