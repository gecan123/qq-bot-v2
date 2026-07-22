import { createHash } from 'node:crypto'
import { createLogger } from '../logger.js'
import {
  SNAPSHOT_SCHEMA_VERSION,
  type PersistedAgentSnapshot,
} from './agent-context.types.js'
import type { AgentLedgerProjection, AgentRuntimeState } from './agent-ledger.types.js'
import { projectAgentLedger } from './agent-ledger-projection.js'
import type {
  AgentLedgerRepo,
  CanonicalAgentState,
  StoredAgentCheckpoint,
} from './agent-ledger-repo.js'
import { validateBotSnapshotIntegrity } from './snapshot-integrity.js'

export const AGENT_CHECKPOINT_SCHEMA_VERSION = 1

const log = createLogger('AGENT_LEDGER_LOADER')

export type AgentCheckpointStatus = 'hit' | 'missing' | 'stale' | 'corrupt'

export interface LoadedAgentLedger {
  projection: AgentLedgerProjection
  runtimeState: AgentRuntimeState
  checkpointStatus: AgentCheckpointStatus
}

export interface AgentLedgerLoader {
  load(): Promise<LoadedAgentLedger>
}

interface CheckpointProjectionPayload {
  snapshot: PersistedAgentSnapshot
  activeEntryCount: number
  permanentEntryCount: number
}

export function createAgentLedgerLoader(input: { repo: AgentLedgerRepo }): AgentLedgerLoader {
  return {
    async load() {
      const canonical = await input.repo.loadCanonicalState()
      // Canonical validation always happens before considering a cache hit. A valid
      // checkpoint must never hide a damaged permanent ledger.
      const canonicalProjection = projectAgentLedger({
        entries: canonical.entries,
        runtimeState: canonical.runtimeState,
      })
      const fingerprint = fingerprintCanonicalAgentState(canonical)

      let checkpoint: StoredAgentCheckpoint | null = null
      let checkpointStatus: AgentCheckpointStatus = 'missing'
      try {
        checkpoint = await input.repo.loadCheckpoint()
      } catch (error) {
        checkpointStatus = 'corrupt'
        log.warn({ error }, 'agent_checkpoint_read_failed_rebuilding')
      }

      if (checkpoint != null) {
        if (
          checkpoint.schemaVersion !== AGENT_CHECKPOINT_SCHEMA_VERSION
          || checkpoint.throughEntryId !== canonicalProjection.throughEntryId
          || checkpoint.fingerprint !== fingerprint
        ) {
          checkpointStatus = 'stale'
        } else {
          const cached = parseCheckpointProjection(
            checkpoint.projection,
            checkpoint.throughEntryId,
            canonical.runtimeState,
          )
          if (cached != null && projectionsMatch(cached, canonicalProjection)) {
            return {
              projection: cached,
              runtimeState: canonical.runtimeState,
              checkpointStatus: 'hit',
            }
          }
          checkpointStatus = 'corrupt'
        }
      }

      await saveCheckpointBestEffort(input.repo, canonicalProjection, fingerprint)
      return {
        projection: canonicalProjection,
        runtimeState: canonical.runtimeState,
        checkpointStatus,
      }
    },
  }
}

export function fingerprintCanonicalAgentState(canonical: CanonicalAgentState): string {
  const serializable = {
    entries: canonical.entries.map((entry) => ({
      id: entry.id.toString(),
      entryType: entry.entryType,
      payload: entry.payload,
      createdAt: entry.createdAt.toISOString(),
    })),
    runtimeState: {
      schemaVersion: canonical.runtimeState.schemaVersion,
      mailboxCursors: canonical.runtimeState.mailboxCursors,
      inboxReadCursors: canonical.runtimeState.inboxReadCursors,
      mailboxContinuity: canonical.runtimeState.mailboxContinuity,
      goalRevision: canonical.runtimeState.goalRevision,
      qqConversationFocus: canonical.runtimeState.qqConversationFocus,
      lastWakeAt: canonical.runtimeState.lastWakeAt?.toISOString() ?? null,
      ledgerHeadEntryId: canonical.runtimeState.ledgerHeadEntryId?.toString() ?? null,
    },
  }
  return createHash('sha256').update(stableStringify(serializable)).digest('hex')
}

async function saveCheckpointBestEffort(
  repo: AgentLedgerRepo,
  projection: AgentLedgerProjection,
  fingerprint: string,
): Promise<void> {
  try {
    await repo.saveCheckpoint({
      schemaVersion: AGENT_CHECKPOINT_SCHEMA_VERSION,
      throughEntryId: projection.throughEntryId,
      fingerprint,
      projection: checkpointProjectionPayload(projection),
    })
  } catch (error) {
    log.warn({ error }, 'agent_checkpoint_refresh_failed_canonical_state_preserved')
  }
}

function checkpointProjectionPayload(
  projection: AgentLedgerProjection,
): CheckpointProjectionPayload {
  return {
    snapshot: structuredClone(projection.snapshot),
    activeEntryCount: projection.activeEntryCount,
    permanentEntryCount: projection.permanentEntryCount,
  }
}

function parseCheckpointProjection(
  value: unknown,
  throughEntryId: bigint | null,
  runtimeState: AgentRuntimeState,
): AgentLedgerProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'snapshot',
    'activeEntryCount',
    'permanentEntryCount',
  ])) return null
  if (!isNonNegativeSafeInteger(value.activeEntryCount)) return null
  if (!isNonNegativeSafeInteger(value.permanentEntryCount)) return null
  if (!isPersistedSnapshot(value.snapshot)) return null
  const snapshot = structuredClone(value.snapshot)
  const validation = validateBotSnapshotIntegrity({
    snapshot,
    mailboxCursors: runtimeState.mailboxCursors,
    mailboxContinuity: runtimeState.mailboxContinuity,
    goalRevision: runtimeState.goalRevision,
  })
  if (!validation.ok) return null
  return {
    throughEntryId,
    activeEntryCount: value.activeEntryCount,
    permanentEntryCount: value.permanentEntryCount,
    snapshot,
  }
}

function projectionsMatch(left: AgentLedgerProjection, right: AgentLedgerProjection): boolean {
  return left.throughEntryId === right.throughEntryId
    && left.activeEntryCount === right.activeEntryCount
    && left.permanentEntryCount === right.permanentEntryCount
    && JSON.stringify(left.snapshot) === JSON.stringify(right.snapshot)
}

function isPersistedSnapshot(value: unknown): value is PersistedAgentSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'messages',
    'qqConversationFocus',
  ])) return false
  return value.schemaVersion === SNAPSHOT_SCHEMA_VERSION
    && Array.isArray(value.messages)
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortJson)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key])
  }
  return sorted
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
