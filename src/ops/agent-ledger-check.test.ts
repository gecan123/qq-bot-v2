import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SNAPSHOT_SCHEMA_VERSION } from '../agent/agent-context.types.js'
import { fingerprintCanonicalAgentState } from '../agent/agent-ledger-loader.js'
import type {
  AgentLedgerEntry,
  AgentRuntimeState,
  CompactionLedgerPayload,
} from '../agent/agent-ledger.types.js'
import { AGENT_RUNTIME_STATE_SCHEMA_VERSION } from '../agent/agent-ledger.types.js'
import type {
  CanonicalAgentState,
  StoredAgentCheckpoint,
} from '../agent/agent-ledger-repo.js'
import { createEmptyMailboxContinuityState } from '../agent/mailbox-continuity.js'
import { projectAgentLedger } from '../agent/agent-ledger-projection.js'
import {
  checkAgentLedger,
  createPrismaAgentLedgerCheckSource,
  loadCanonicalAgentState,
} from './agent-ledger-check.js'

const createdAt = new Date('2026-07-15T00:00:00.000Z')

function message(id: bigint, content: string): AgentLedgerEntry {
  return {
    id,
    entryType: 'message',
    payload: { schemaVersion: 1, message: { role: 'user', content } },
    createdAt,
  }
}

function compaction(
  id: bigint,
  firstKeptEntryId: bigint,
  previousCompactionEntryId: bigint | null,
): AgentLedgerEntry {
  const payload: CompactionLedgerPayload = {
    schemaVersion: 1,
    summary: [
      '## 讨论过的话题', '历史。',
      '## 群友信息', '无。',
      '## 我的目标、承诺和状态', '继续。',
      '## 关键约束与决定', '无。',
      '## 工具调用结果', '无。',
      '## 情绪和氛围', '平静。',
      '## 下一步', '继续。',
    ].join('\n'),
    firstKeptEntryId: firstKeptEntryId.toString(),
    tokensBefore: 100,
    estimatedTokensAfter: 50,
    reason: 'threshold',
    isSplitTurn: false,
    previousCompactionEntryId: previousCompactionEntryId?.toString() ?? null,
    mailboxAttentionState: {},
    restResumeState: null,
  }
  return { id, entryType: 'compaction', payload, createdAt }
}

function state(entries: AgentLedgerEntry[]): CanonicalAgentState {
  const runtimeState: AgentRuntimeState = {
    schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
    mailboxCursors: {},
    inboxReadCursors: {},
    mailboxContinuity: createEmptyMailboxContinuityState(),
    goalRevision: 0,
    qqConversationFocus: null,
    lastWakeAt: null,
    ledgerHeadEntryId: entries.at(-1)?.id ?? null,
  }
  return { entries, runtimeState }
}

function checkpointFor(canonical: CanonicalAgentState): StoredAgentCheckpoint {
  const projection = projectAgentLedger(canonical)
  return {
    schemaVersion: 1,
    throughEntryId: projection.throughEntryId,
    fingerprint: fingerprintCanonicalAgentState(canonical),
    projection: {
      snapshot: projection.snapshot,
      activeEntryCount: projection.activeEntryCount,
      permanentEntryCount: projection.permanentEntryCount,
    },
    createdAt,
    updatedAt: createdAt,
  }
}

describe('checkAgentLedger', () => {
  test('shared raw loader reads the canonical ledger and runtime singleton', async () => {
    const canonical = state([message(1n, 'hello')])
    const loaded = await loadCanonicalAgentState({
      botAgentLedgerEntry: { async findMany() { return canonical.entries } },
      botAgentRuntimeState: { async findUnique() { return canonical.runtimeState } },
    })

    assert.deepEqual(loaded, canonical)
  })

  test('reports a valid repeated-compaction ledger and matching checkpoint without writes', async () => {
    const canonical = state([
      message(1n, 'old'),
      message(2n, 'kept once'),
      compaction(3n, 2n, null),
      message(4n, 'kept twice'),
      compaction(5n, 4n, 3n),
    ])
    const report = await checkAgentLedger({
      async loadCanonicalState() { return canonical },
      async loadCheckpoint() { return checkpointFor(canonical) },
    })

    assert.equal(report.ok, true)
    assert.equal(report.headEntryId, '5')
    assert.equal(report.latestCompactionEntryId, '5')
    assert.equal(report.permanentEntryCount, 5)
    assert.equal(report.activeEntryCount, 1)
    assert.ok(report.projectionTokens > 0)
    assert.equal(report.checkpointStatus, 'hit')
    assert.deepEqual(report.errors, [])
  })

  test('fails closed on unknown schema, ID/boundary damage, and orphan tool results', async () => {
    const damaged: Array<{ name: string; canonical: CanonicalAgentState }> = [
      {
        name: 'unknown schema',
        canonical: state([{
          ...message(1n, 'bad'),
          payload: { schemaVersion: 99, message: { role: 'user', content: 'bad' } },
        } as unknown as AgentLedgerEntry]),
      },
      {
        name: 'non-increasing ID',
        canonical: state([message(2n, 'first'), message(1n, 'second')]),
      },
      {
        name: 'missing boundary',
        canonical: state([message(1n, 'old'), compaction(2n, 9n, null)]),
      },
      {
        name: 'orphan tool result',
        canonical: state([{
          id: 1n,
          entryType: 'message',
          payload: {
            schemaVersion: 1,
            message: { role: 'tool', toolCallId: 'missing', content: '{}' },
          },
          createdAt,
        }]),
      },
    ]

    for (const fixture of damaged) {
      const report = await checkAgentLedger({
        async loadCanonicalState() { return fixture.canonical },
        async loadCheckpoint() { return null },
      })
      assert.equal(report.ok, false, fixture.name)
      assert.ok(report.errors.some((error) => error.code === 'ledger_integrity'), fixture.name)
    }
  })

  test('reports a stale checkpoint without repairing it', async () => {
    const canonical = state([message(1n, 'one'), message(2n, 'two')])
    const stale: StoredAgentCheckpoint = {
      schemaVersion: 1,
      throughEntryId: 1n,
      fingerprint: 'stale',
      projection: {
        snapshot: {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          messages: [{ role: 'user', content: 'one' }],
          qqConversationFocus: null,
        },
        activeEntryCount: 1,
        permanentEntryCount: 1,
      },
      createdAt,
      updatedAt: createdAt,
    }
    let reads = 0
    const report = await checkAgentLedger({
      async loadCanonicalState() { reads++; return canonical },
      async loadCheckpoint() { reads++; return stale },
    })

    assert.equal(report.ok, true)
    assert.equal(report.checkpointStatus, 'stale')
    assert.equal(reads, 2)
  })

  test('reports an unreadable checkpoint as corrupt while preserving canonical health', async () => {
    const canonical = state([message(1n, 'one')])
    const report = await checkAgentLedger({
      async loadCanonicalState() { return canonical },
      async loadCheckpoint() { throw new Error('invalid checkpoint json') },
    })

    assert.equal(report.ok, true)
    assert.equal(report.checkpointStatus, 'corrupt')
    assert.deepEqual(report.errors, [])
  })

  test('the Prisma source reads raw rows so a corrupt entry keeps its entry id', async () => {
    const report = await checkAgentLedger(createPrismaAgentLedgerCheckSource({
      botAgentLedgerEntry: {
        async findMany() {
          return [{
            id: 42n,
            entryType: 'message',
            payload: { schemaVersion: 99, message: { role: 'user', content: 'bad' } },
            createdAt,
          }]
        },
      },
      botAgentRuntimeState: {
        async findUnique() {
          return {
            ...state([]).runtimeState,
            ledgerHeadEntryId: 42n,
          }
        },
      },
      botAgentCheckpoint: { async findUnique() { return null } },
    }))

    assert.equal(report.ok, false)
    assert.equal(report.errors[0]?.entryId, '42')
  })
})
