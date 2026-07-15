import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SNAPSHOT_SCHEMA_VERSION } from './agent-context.types.js'
import {
  AGENT_LEDGER_SCHEMA_VERSION,
  AGENT_RUNTIME_STATE_SCHEMA_VERSION,
  type AgentLedgerEntry,
  type AgentRuntimeState,
} from './agent-ledger.types.js'
import {
  AGENT_CHECKPOINT_SCHEMA_VERSION,
  createAgentLedgerLoader,
  fingerprintCanonicalAgentState,
} from './agent-ledger-loader.js'
import type {
  AgentCheckpointInput,
  AgentLedgerRepo,
  CanonicalAgentState,
  StoredAgentCheckpoint,
} from './agent-ledger-repo.js'
import { createEmptyMailboxContinuityState } from './mailbox-continuity.js'

const CREATED_AT = new Date('2026-07-15T12:00:00.000Z')

function messageEntry(id: bigint, content: string): AgentLedgerEntry {
  return {
    id,
    entryType: 'message',
    payload: {
      schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
      message: { role: 'user', content },
    },
    createdAt: CREATED_AT,
  }
}

function runtimeState(head: bigint | null): AgentRuntimeState {
  return {
    schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
    mailboxCursors: {},
    mailboxContinuity: createEmptyMailboxContinuityState(),
    goalRevision: 0,
    activeToolCapabilities: [],
    lastWakeAt: null,
    ledgerHeadEntryId: head,
  }
}

function canonical(entries: AgentLedgerEntry[]): CanonicalAgentState {
  return { entries, runtimeState: runtimeState(entries.at(-1)?.id ?? null) }
}

function createFakeRepo(initial: CanonicalAgentState): {
  repo: AgentLedgerRepo
  setCanonical(value: CanonicalAgentState): void
  setCheckpoint(value: StoredAgentCheckpoint | null): void
  checkpoint(): StoredAgentCheckpoint | null
  saveCount(): number
  failCheckpointSaves(): void
} {
  let current = structuredClone(initial)
  let checkpoint: StoredAgentCheckpoint | null = null
  let saves = 0
  let failSaves = false
  const repo: AgentLedgerRepo = {
    async loadCanonicalState() {
      return structuredClone(current)
    },
    async loadCheckpoint() {
      return structuredClone(checkpoint)
    },
    async saveCheckpoint(input: AgentCheckpointInput) {
      saves++
      if (failSaves) throw new Error('checkpoint unavailable')
      checkpoint = {
        ...structuredClone(input),
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      }
    },
    async appendMessages() {
      throw new Error('not used')
    },
    async appendCompaction() {
      throw new Error('not used')
    },
    async updateRuntime() {
      throw new Error('not used')
    },
  }
  return {
    repo,
    setCanonical(value) { current = structuredClone(value) },
    setCheckpoint(value) { checkpoint = structuredClone(value) },
    checkpoint: () => structuredClone(checkpoint),
    saveCount: () => saves,
    failCheckpointSaves() { failSaves = true },
  }
}

describe('createAgentLedgerLoader', () => {
  test('rebuilds from canonical ledger when checkpoint is absent', async () => {
    const fake = createFakeRepo(canonical([messageEntry(1n, 'hello')]))
    const loader = createAgentLedgerLoader({ repo: fake.repo })

    const loaded = await loader.load()

    assert.equal(loaded.checkpointStatus, 'missing')
    assert.deepEqual(loaded.projection.snapshot.messages, [{ role: 'user', content: 'hello' }])
    assert.equal(fake.saveCount(), 1)
    assert.equal(fake.checkpoint()?.throughEntryId, 1n)
  })

  test('uses checkpoint only when head, schema, fingerprint, and projection all match', async () => {
    const fake = createFakeRepo(canonical([messageEntry(1n, 'hello')]))
    const loader = createAgentLedgerLoader({ repo: fake.repo })
    await loader.load()
    const savesAfterWarmup = fake.saveCount()

    const loaded = await loader.load()

    assert.equal(loaded.checkpointStatus, 'hit')
    assert.equal(fake.saveCount(), savesAfterWarmup)
    assert.deepEqual(loaded.projection.snapshot.messages, [{ role: 'user', content: 'hello' }])
  })

  test('rebuilds and overwrites a stale checkpoint', async () => {
    const first = canonical([messageEntry(1n, 'one')])
    const fake = createFakeRepo(first)
    const loader = createAgentLedgerLoader({ repo: fake.repo })
    await loader.load()
    fake.setCanonical(canonical([messageEntry(1n, 'one'), messageEntry(2n, 'two')]))

    const loaded = await loader.load()

    assert.equal(loaded.checkpointStatus, 'stale')
    assert.equal(fake.saveCount(), 2)
    assert.equal(fake.checkpoint()?.throughEntryId, 2n)
    assert.deepEqual(loaded.projection.snapshot.messages.map((message) => message.content), ['one', 'two'])
  })

  test('rebuilds and overwrites a corrupt checkpoint projection', async () => {
    const state = canonical([messageEntry(1n, 'one')])
    const fake = createFakeRepo(state)
    fake.setCheckpoint({
      schemaVersion: AGENT_CHECKPOINT_SCHEMA_VERSION,
      throughEntryId: 1n,
      fingerprint: fingerprintCanonicalAgentState(state),
      projection: {
        snapshot: {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          messages: [{ role: 'future', content: 'bad' }],
          activeToolCapabilities: [],
        },
        activeEntryCount: 1,
        permanentEntryCount: 1,
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    const loader = createAgentLedgerLoader({ repo: fake.repo })

    const loaded = await loader.load()

    assert.equal(loaded.checkpointStatus, 'corrupt')
    assert.deepEqual(loaded.projection.snapshot.messages, [{ role: 'user', content: 'one' }])
    assert.equal(fake.saveCount(), 1)
  })

  test('fails closed on corrupt canonical ledger even when checkpoint metadata matches', async () => {
    const corrupt: CanonicalAgentState = {
      entries: [{
        id: 1n,
        entryType: 'message',
        payload: {
          schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'lookup', args: {} }],
          },
        },
        createdAt: CREATED_AT,
      }],
      runtimeState: runtimeState(1n),
    }
    const fake = createFakeRepo(corrupt)
    fake.setCheckpoint({
      schemaVersion: AGENT_CHECKPOINT_SCHEMA_VERSION,
      throughEntryId: 1n,
      fingerprint: fingerprintCanonicalAgentState(corrupt),
      projection: {
        snapshot: {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          messages: [],
          activeToolCapabilities: [],
        },
        activeEntryCount: 0,
        permanentEntryCount: 1,
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    const loader = createAgentLedgerLoader({ repo: fake.repo })

    await assert.rejects(loader.load(), /must be tool result for assistant tool call call-1/)
    assert.equal(fake.saveCount(), 0)
  })

  test('does not fail canonical recovery when checkpoint refresh fails', async () => {
    const fake = createFakeRepo(canonical([messageEntry(1n, 'hello')]))
    fake.failCheckpointSaves()
    const loader = createAgentLedgerLoader({ repo: fake.repo })

    const loaded = await loader.load()

    assert.equal(loaded.checkpointStatus, 'missing')
    assert.deepEqual(loaded.projection.snapshot.messages, [{ role: 'user', content: 'hello' }])
  })
})
