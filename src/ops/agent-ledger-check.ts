import { isDeepStrictEqual } from 'node:util'
import type { DurableAgentMessage } from '../agent/agent-context.types.js'
import {
  AGENT_CHECKPOINT_SCHEMA_VERSION,
  fingerprintCanonicalAgentState,
  type AgentCheckpointStatus,
} from '../agent/agent-ledger-loader.js'
import { AgentLedgerIntegrityError, projectAgentLedger } from '../agent/agent-ledger-projection.js'
import type {
  CanonicalAgentState,
  StoredAgentCheckpoint,
} from '../agent/agent-ledger-repo.js'
import { estimateEntryTokens } from '../agent/compaction-token-estimator.js'

export interface AgentLedgerCheckReport {
  ok: boolean
  headEntryId: string | null
  latestCompactionEntryId: string | null
  permanentEntryCount: number
  activeEntryCount: number
  projectionTokens: number
  checkpointStatus: AgentCheckpointStatus
  errors: Array<{ entryId?: string; code: string; message: string }>
}

export interface AgentLedgerCheckSource {
  loadCanonicalState(): Promise<CanonicalAgentState>
  loadCheckpoint(): Promise<StoredAgentCheckpoint | null>
}

export interface AgentLedgerCheckPrismaClient {
  botAgentLedgerEntry: {
    findMany(input: { orderBy: { id: 'asc' } }): Promise<Array<{
      id: bigint
      entryType: string
      payload: unknown
      createdAt: Date
    }>>
  }
  botAgentRuntimeState: {
    findUnique(input: { where: { id: 1 } }): Promise<null | {
      schemaVersion: number
      mailboxCursors: unknown
      mailboxContinuity: unknown
      goalRevision: number
      activeToolCapabilities: unknown
      qqConversationFocus: unknown
      lastWakeAt: Date | null
      ledgerHeadEntryId: bigint | null
    }>
  }
  botAgentCheckpoint: {
    findUnique(input: { where: { id: 1 } }): Promise<null | {
      schemaVersion: number
      throughEntryId: bigint | null
      fingerprint: string
      projection: unknown
      createdAt: Date
      updatedAt: Date
    }>
  }
}

export function createPrismaAgentLedgerCheckSource(
  client: AgentLedgerCheckPrismaClient,
): AgentLedgerCheckSource {
  return {
    async loadCanonicalState() {
      const [rows, runtime] = await Promise.all([
        client.botAgentLedgerEntry.findMany({ orderBy: { id: 'asc' } }),
        client.botAgentRuntimeState.findUnique({ where: { id: 1 } }),
      ])
      if (!runtime) throw new Error('bot_agent_runtime_state singleton row is missing')
      return {
        entries: rows as CanonicalAgentState['entries'],
        runtimeState: {
          schemaVersion: runtime.schemaVersion,
          mailboxCursors: runtime.mailboxCursors,
          mailboxContinuity: runtime.mailboxContinuity,
          goalRevision: runtime.goalRevision,
          activeToolCapabilities: runtime.activeToolCapabilities,
          qqConversationFocus: runtime.qqConversationFocus,
          lastWakeAt: runtime.lastWakeAt,
          ledgerHeadEntryId: runtime.ledgerHeadEntryId,
        } as CanonicalAgentState['runtimeState'],
      }
    },
    async loadCheckpoint() {
      const checkpoint = await client.botAgentCheckpoint.findUnique({ where: { id: 1 } })
      return checkpoint as StoredAgentCheckpoint | null
    },
  }
}

export async function checkAgentLedger(
  source: AgentLedgerCheckSource,
): Promise<AgentLedgerCheckReport> {
  let canonical: CanonicalAgentState
  try {
    canonical = await source.loadCanonicalState()
  } catch (error) {
    return emptyReport([{
      code: 'canonical_read_failed',
      message: errorMessage(error),
    }])
  }

  const report: AgentLedgerCheckReport = {
    ok: true,
    headEntryId: formatId(canonical.runtimeState.ledgerHeadEntryId),
    latestCompactionEntryId: latestCompactionId(canonical),
    permanentEntryCount: canonical.entries.length,
    activeEntryCount: 0,
    projectionTokens: 0,
    checkpointStatus: 'missing',
    errors: [],
  }

  let projection: ReturnType<typeof projectAgentLedger> | null = null
  try {
    projection = projectAgentLedger(canonical)
    report.activeEntryCount = projection.activeEntryCount
    report.projectionTokens = estimateProjectionTokens(projection.snapshot.messages)
  } catch (error) {
    report.errors.push(...ledgerErrors(error, canonical))
  }

  let checkpoint: StoredAgentCheckpoint | null = null
  try {
    checkpoint = await source.loadCheckpoint()
  } catch {
    report.checkpointStatus = 'corrupt'
  }
  if (checkpoint != null && projection != null) {
    report.checkpointStatus = classifyCheckpoint(checkpoint, canonical, projection)
  }

  report.ok = report.errors.length === 0
  return report
}

function classifyCheckpoint(
  checkpoint: StoredAgentCheckpoint,
  canonical: CanonicalAgentState,
  projection: ReturnType<typeof projectAgentLedger>,
): AgentCheckpointStatus {
  if (
    checkpoint.schemaVersion !== AGENT_CHECKPOINT_SCHEMA_VERSION
    || checkpoint.throughEntryId !== projection.throughEntryId
    || checkpoint.fingerprint !== fingerprintCanonicalAgentState(canonical)
  ) {
    return 'stale'
  }
  const expected = {
    snapshot: projection.snapshot,
    activeEntryCount: projection.activeEntryCount,
    permanentEntryCount: projection.permanentEntryCount,
  }
  return isDeepStrictEqual(checkpoint.projection, expected) ? 'hit' : 'corrupt'
}

function estimateProjectionTokens(messages: readonly DurableAgentMessage[]): number {
  return messages.reduce((total, message, index) => {
    const estimate = estimateEntryTokens({
      id: BigInt(index + 1),
      entryType: 'message',
      payload: { schemaVersion: 1, message },
      createdAt: new Date(0),
    })
    const next = total + estimate.tokens
    return Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER
  }, 0)
}

function ledgerErrors(
  error: unknown,
  canonical: CanonicalAgentState,
): AgentLedgerCheckReport['errors'] {
  const messages = error instanceof AgentLedgerIntegrityError
    ? error.errors
    : [errorMessage(error)]
  return messages.map((message) => {
    const indexMatch = /entries\[(\d+)]/.exec(message)
    const entry = indexMatch ? canonical.entries[Number(indexMatch[1])] : undefined
    return {
      ...(entry && typeof entry.id === 'bigint' ? { entryId: entry.id.toString() } : {}),
      code: 'ledger_integrity',
      message,
    }
  })
}

function latestCompactionId(canonical: CanonicalAgentState): string | null {
  for (let index = canonical.entries.length - 1; index >= 0; index--) {
    const entry = canonical.entries[index]
    if (entry?.entryType === 'compaction' && typeof entry.id === 'bigint') {
      return entry.id.toString()
    }
  }
  return null
}

function emptyReport(errors: AgentLedgerCheckReport['errors']): AgentLedgerCheckReport {
  return {
    ok: false,
    headEntryId: null,
    latestCompactionEntryId: null,
    permanentEntryCount: 0,
    activeEntryCount: 0,
    projectionTokens: 0,
    checkpointStatus: 'missing',
    errors,
  }
}

function formatId(value: bigint | null): string | null {
  return value == null ? null : value.toString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
