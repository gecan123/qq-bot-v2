import { createAgentLedgerLoader, type AgentLedgerLoader } from '../agent-ledger-loader.js'
import {
  AgentLedgerHeadChangedError,
  type AgentLedgerRepo,
  type AgentRuntimePatch,
  type CanonicalAgentState,
} from '../agent-ledger-repo.js'
import { projectAgentLedger } from '../agent-ledger-projection.js'
import type { DurableAgentMessage, PersistedAgentSnapshot } from '../agent-context.types.js'
import {
  AGENT_LEDGER_SCHEMA_VERSION,
  AGENT_RUNTIME_STATE_SCHEMA_VERSION,
  type AgentLedgerEntry,
  type AgentRuntimeState,
} from '../agent-ledger.types.js'
import { createEmptyMailboxContinuityState } from '../mailbox-continuity.js'

export interface TestAgentLedgerHarness {
  repo: AgentLedgerRepo
  loader: AgentLedgerLoader
  snapshots: PersistedAgentSnapshot[]
  runtimeStates: AgentRuntimeState[]
  canonical(): CanonicalAgentState
}

export function createTestAgentLedger(input: {
  messages?: readonly DurableAgentMessage[]
  runtimeState?: Partial<Omit<AgentRuntimeState, 'schemaVersion' | 'ledgerHeadEntryId'>>
} = {}): TestAgentLedgerHarness {
  let entries: AgentLedgerEntry[] = (input.messages ?? []).map((message, index) => ({
    id: BigInt(index + 1),
    entryType: 'message',
    payload: { schemaVersion: AGENT_LEDGER_SCHEMA_VERSION, message: structuredClone(message) },
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
  }))
  let nextId = BigInt(entries.length + 1)
  let runtimeState: AgentRuntimeState = {
    schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
    mailboxCursors: {},
    mailboxContinuity: createEmptyMailboxContinuityState(),
    goalRevision: 0,
    activeToolCapabilities: [],
    lastWakeAt: null,
    ...structuredClone(input.runtimeState ?? {}),
    ledgerHeadEntryId: entries.at(-1)?.id ?? null,
  }
  const snapshots: PersistedAgentSnapshot[] = []
  const runtimeStates: AgentRuntimeState[] = []

  const applyPatch = (patch: AgentRuntimePatch | undefined): void => {
    if (!patch) return
    runtimeState = {
      ...runtimeState,
      ...structuredClone(patch),
      lastWakeAt: patch.lastWakeAt === undefined ? runtimeState.lastWakeAt : patch.lastWakeAt,
    }
  }
  const record = (): void => {
    const projection = projectAgentLedger({ entries, runtimeState })
    snapshots.push(structuredClone(projection.snapshot))
    runtimeStates.push(structuredClone(runtimeState))
  }
  const canonical = (): CanonicalAgentState => ({
    entries: structuredClone(entries),
    runtimeState: structuredClone(runtimeState),
  })

  const repo: AgentLedgerRepo = {
    async loadCanonicalState() {
      return canonical()
    },
    async appendMessages(append) {
      const appendedEntries: AgentLedgerEntry[] = append.messages.map((message) => ({
        id: nextId++,
        entryType: 'message',
        payload: { schemaVersion: AGENT_LEDGER_SCHEMA_VERSION, message: structuredClone(message) },
        createdAt: new Date('2026-07-15T00:00:01.000Z'),
      }))
      entries.push(...appendedEntries)
      applyPatch(append.runtimePatch)
      runtimeState.ledgerHeadEntryId = entries.at(-1)?.id ?? null
      record()
      return { appendedEntries, runtimeState: structuredClone(runtimeState) }
    },
    async appendCompaction(append) {
      assertHead(append.expectedHeadEntryId, runtimeState.ledgerHeadEntryId)
      const entry: AgentLedgerEntry = {
        id: nextId++,
        entryType: 'compaction',
        payload: structuredClone(append.payload),
        createdAt: new Date('2026-07-15T00:00:02.000Z'),
      }
      entries.push(entry)
      applyPatch(append.runtimePatch)
      runtimeState.ledgerHeadEntryId = entry.id
      record()
      return { appendedEntries: [entry], runtimeState: structuredClone(runtimeState) }
    },
    async updateRuntime(update) {
      assertHead(update.expectedHeadEntryId, runtimeState.ledgerHeadEntryId)
      applyPatch(update.patch)
      record()
      return structuredClone(runtimeState)
    },
    async saveCheckpoint() {},
    async loadCheckpoint() { return null },
  }

  return {
    repo,
    loader: createAgentLedgerLoader({ repo }),
    snapshots,
    runtimeStates,
    canonical,
  }
}

function assertHead(expected: bigint | null, actual: bigint | null): void {
  if (expected !== actual) throw new AgentLedgerHeadChangedError(expected, actual)
}
