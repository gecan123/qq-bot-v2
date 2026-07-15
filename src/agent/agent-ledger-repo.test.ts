import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SNAPSHOT_SCHEMA_VERSION, type DurableAgentMessage } from './agent-context.types.js'
import {
  AGENT_LEDGER_SCHEMA_VERSION,
  AGENT_RUNTIME_STATE_SCHEMA_VERSION,
  type AgentRuntimeState,
  type CompactionLedgerPayload,
} from './agent-ledger.types.js'
import {
  AgentLedgerHeadChangedError,
  createAgentLedgerRepo,
  type AgentLedgerPersistenceClient,
} from './agent-ledger-repo.js'
import { createEmptyMailboxContinuityState } from './mailbox-continuity.js'

interface FakeState {
  entries: Array<{
    id: bigint
    entryType: string
    payload: unknown
    createdAt: Date
  }>
  runtime: {
    id: number
    schemaVersion: number
    mailboxCursors: unknown
    mailboxContinuity: unknown
    goalRevision: number
    activeToolCapabilities: unknown
    lastWakeAt: Date | null
    ledgerHeadEntryId: bigint | null
    updatedAt: Date
  }
  checkpoint: null | {
    id: number
    schemaVersion: number
    throughEntryId: bigint | null
    fingerprint: string
    projection: unknown
    createdAt: Date
    updatedAt: Date
  }
  nextEntryId: bigint
}

function initialRuntime(): AgentRuntimeState {
  return {
    schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
    mailboxCursors: {},
    mailboxContinuity: createEmptyMailboxContinuityState(),
    goalRevision: 0,
    activeToolCapabilities: [],
    lastWakeAt: null,
    ledgerHeadEntryId: null,
  }
}

function createFakeClient(options: { failOnEntryCreate?: number } = {}): {
  client: AgentLedgerPersistenceClient
  state(): FakeState
  transactionCount(): number
  checkpointWritesInsideTransaction(): number
} {
  const now = new Date('2026-07-15T12:00:00.000Z')
  let state: FakeState = {
    entries: [],
    runtime: {
      id: 1,
      ...initialRuntime(),
      updatedAt: now,
    },
    checkpoint: null,
    nextEntryId: 1n,
  }
  let transactions = 0
  let transactionDepth = 0
  let checkpointWritesInTransaction = 0
  let createAttempts = 0

  function methods(target: FakeState): Omit<AgentLedgerPersistenceClient, '$transaction'> {
    return {
      async lockRuntimeState() {},
      botAgentLedgerEntry: {
        async findMany() {
          return structuredClone(target.entries)
        },
        async create(args) {
          createAttempts++
          if (options.failOnEntryCreate === createAttempts) {
            throw new Error(`injected create failure ${createAttempts}`)
          }
          const row = {
            id: target.nextEntryId++,
            entryType: String((args.data as Record<string, unknown>).entryType),
            payload: structuredClone((args.data as Record<string, unknown>).payload),
            createdAt: new Date(now),
          }
          target.entries.push(row)
          return structuredClone(row)
        },
      },
      botAgentRuntimeState: {
        async findUnique() {
          return structuredClone(target.runtime)
        },
        async update(args) {
          const data = args.data as Record<string, unknown>
          target.runtime = {
            ...target.runtime,
            ...structuredClone(data),
            updatedAt: new Date(now),
          } as FakeState['runtime']
          return structuredClone(target.runtime)
        },
      },
      botAgentCheckpoint: {
        async findUnique() {
          return structuredClone(target.checkpoint)
        },
        async upsert(args) {
          if (transactionDepth > 0) checkpointWritesInTransaction++
          const data = target.checkpoint == null ? args.create : args.update
          const saved: NonNullable<FakeState['checkpoint']> = {
            id: 1,
            ...structuredClone(data),
            createdAt: target.checkpoint?.createdAt ?? new Date(now),
            updatedAt: new Date(now),
          } as NonNullable<FakeState['checkpoint']>
          target.checkpoint = saved
          return structuredClone(saved)
        },
      },
    }
  }

  const rootMethods = methods(state)
  const client: AgentLedgerPersistenceClient = {
    ...rootMethods,
    async $transaction(task) {
      transactions++
      transactionDepth++
      const draft = structuredClone(state)
      const txMethods = methods(draft)
      const tx = {
        ...txMethods,
        $transaction: async <T>(nested: (nestedTx: AgentLedgerPersistenceClient) => Promise<T>) => nested(tx),
      } as AgentLedgerPersistenceClient
      try {
        const result = await task(tx)
        state = draft
        Object.assign(client, methods(state))
        return result
      } finally {
        transactionDepth--
      }
    },
  }

  return {
    client,
    state: () => structuredClone(state),
    transactionCount: () => transactions,
    checkpointWritesInsideTransaction: () => checkpointWritesInTransaction,
  }
}

const messages: DurableAgentMessage[] = [
  { role: 'user', content: '问题' },
  { role: 'assistant', content: '', toolCalls: [] },
]

function compactionPayload(overrides: Partial<CompactionLedgerPayload> = {}): CompactionLedgerPayload {
  return {
    schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
    summary: '历史摘要',
    firstKeptEntryId: null,
    tokensBefore: 100_000,
    estimatedTokensAfter: 20_000,
    reason: 'threshold',
    isSplitTurn: false,
    previousCompactionEntryId: null,
    mailboxAttentionState: {},
    restResumeState: null,
    ...overrides,
  }
}

describe('createAgentLedgerRepo', () => {
  test('appends messages in order and advances the runtime ledger head atomically', async () => {
    const fake = createFakeClient()
    const repo = createAgentLedgerRepo({ client: fake.client })

    const result = await repo.appendMessages({ messages })

    assert.deepEqual(result.appendedEntries.map((entry) => [entry.id, entry.entryType]), [
      [1n, 'message'],
      [2n, 'message'],
    ])
    assert.deepEqual(fake.state().entries.map((entry) => entry.payload), [
      { schemaVersion: AGENT_LEDGER_SCHEMA_VERSION, message: messages[0] },
      { schemaVersion: AGENT_LEDGER_SCHEMA_VERSION, message: messages[1] },
    ])
    assert.equal(fake.state().runtime.ledgerHeadEntryId, 2n)
    assert.equal(result.runtimeState.ledgerHeadEntryId, 2n)
    assert.equal(fake.transactionCount(), 1)
  })

  test('rolls back earlier entries and runtime patches when a later message insert fails', async () => {
    const fake = createFakeClient({ failOnEntryCreate: 2 })
    const repo = createAgentLedgerRepo({ client: fake.client })

    await assert.rejects(
      repo.appendMessages({
        messages,
        runtimePatch: {
          mailboxCursors: { 'qq_private:100': 9 },
          goalRevision: 4,
        },
      }),
      /injected create failure 2/,
    )

    assert.deepEqual(fake.state().entries, [])
    assert.equal(fake.state().runtime.ledgerHeadEntryId, null)
    assert.deepEqual(fake.state().runtime.mailboxCursors, {})
    assert.equal(fake.state().runtime.goalRevision, 0)
  })

  test('commits a visible message with mailbox cursor and Goal revision in one transaction', async () => {
    const fake = createFakeClient()
    const repo = createAgentLedgerRepo({ client: fake.client })

    await repo.appendMessages({
      messages: [{ role: 'user', content: '{"event":"goal_state_changed"}' }],
      runtimePatch: {
        mailboxCursors: { 'qq_private:100': 12 },
        goalRevision: 7,
      },
    })

    assert.equal(fake.state().entries.length, 1)
    assert.deepEqual(fake.state().runtime.mailboxCursors, { 'qq_private:100': 12 })
    assert.equal(fake.state().runtime.goalRevision, 7)
    assert.equal(fake.transactionCount(), 1)
  })

  test('rejects compaction when the expected head changed', async () => {
    const fake = createFakeClient()
    const repo = createAgentLedgerRepo({ client: fake.client })
    await repo.appendMessages({ messages: [messages[0]!] })

    await assert.rejects(
      repo.appendCompaction({ expectedHeadEntryId: null, payload: compactionPayload() }),
      (error: unknown) => error instanceof AgentLedgerHeadChangedError
        && error.expectedHeadEntryId === null
        && error.actualHeadEntryId === 1n,
    )

    assert.equal(fake.state().entries.length, 1)
    assert.equal(fake.state().runtime.ledgerHeadEntryId, 1n)
  })

  test('commits compaction and its runtime continuity patch atomically', async () => {
    const fake = createFakeClient()
    const repo = createAgentLedgerRepo({ client: fake.client })
    await repo.appendMessages({ messages: [messages[0]!] })
    const continuity = createEmptyMailboxContinuityState()
    continuity.compactionEpoch = 1

    const result = await repo.appendCompaction({
      expectedHeadEntryId: 1n,
      payload: compactionPayload(),
      runtimePatch: { mailboxContinuity: continuity },
    })

    assert.equal(result.runtimeState.ledgerHeadEntryId, 2n)
    assert.deepEqual(result.runtimeState.mailboxContinuity, continuity)
    assert.equal(fake.transactionCount(), 2)
  })

  test('stores checkpoints outside the canonical transaction', async () => {
    const fake = createFakeClient()
    const repo = createAgentLedgerRepo({ client: fake.client })

    await repo.saveCheckpoint({
      schemaVersion: 1,
      throughEntryId: null,
      fingerprint: 'abc123',
      projection: {
        snapshot: {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          messages: [],
          activeToolCapabilities: [],
        },
        activeEntryCount: 0,
        permanentEntryCount: 0,
      },
    })

    assert.equal(fake.transactionCount(), 0)
    assert.equal(fake.checkpointWritesInsideTransaction(), 0)
    assert.deepEqual(await repo.loadCheckpoint(), {
      schemaVersion: 1,
      throughEntryId: null,
      fingerprint: 'abc123',
      projection: fake.state().checkpoint!.projection,
      createdAt: new Date('2026-07-15T12:00:00.000Z'),
      updatedAt: new Date('2026-07-15T12:00:00.000Z'),
    })
  })

  test('loads canonical entries and exposes no ledger update/delete path', async () => {
    const fake = createFakeClient()
    const repo = createAgentLedgerRepo({ client: fake.client })
    await repo.appendMessages({ messages: [messages[0]!] })

    const canonical = await repo.loadCanonicalState()

    assert.equal(canonical.entries.length, 1)
    assert.equal(canonical.runtimeState.ledgerHeadEntryId, 1n)
    assert.equal('updateLedgerEntry' in repo, false)
    assert.equal('deleteLedgerEntry' in repo, false)
  })

  test('updates pure runtime state only when the expected head still matches', async () => {
    const fake = createFakeClient()
    const repo = createAgentLedgerRepo({ client: fake.client })

    const updated = await repo.updateRuntime({
      expectedHeadEntryId: null,
      patch: {
        activeToolCapabilities: ['browser'],
        lastWakeAt: new Date('2026-07-15T12:30:00.000Z'),
      },
    })

    assert.deepEqual(updated.activeToolCapabilities, ['browser'])
    assert.equal(updated.lastWakeAt?.toISOString(), '2026-07-15T12:30:00.000Z')
    await assert.rejects(
      repo.updateRuntime({ expectedHeadEntryId: 99n, patch: { lastWakeAt: null } }),
      AgentLedgerHeadChangedError,
    )
  })
})
