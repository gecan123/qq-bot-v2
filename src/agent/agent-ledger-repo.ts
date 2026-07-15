import { prisma } from '../database/client.js'
import type { DurableAgentMessage } from './agent-context.types.js'
import {
  AGENT_LEDGER_SCHEMA_VERSION,
  type AgentLedgerEntry,
  type AgentRuntimeState,
  type CompactionLedgerPayload,
} from './agent-ledger.types.js'
import {
  AgentLedgerIntegrityError,
  parseAgentLedgerEntry,
  parseAgentRuntimeState,
} from './agent-ledger-projection.js'
import type { MailboxContinuityState } from './mailbox-continuity.js'
import type { MailboxCursors } from './mailbox.js'

const RUNTIME_SINGLETON_ID = 1
const CHECKPOINT_SINGLETON_ID = 1

interface LedgerStorageRow {
  id: bigint
  entryType: string
  payload: unknown
  createdAt: Date
}

interface RuntimeStorageRow {
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

interface CheckpointStorageRow {
  id: number
  schemaVersion: number
  throughEntryId: bigint | null
  fingerprint: string
  projection: unknown
  createdAt: Date
  updatedAt: Date
}

export interface AgentLedgerPersistenceClient {
  lockRuntimeState?(): Promise<void>
  $queryRawUnsafe?<T = unknown>(query: string, ...values: unknown[]): Promise<T>
  botAgentLedgerEntry: {
    findMany(args: Record<string, unknown>): Promise<LedgerStorageRow[]>
    create(args: { data: Record<string, unknown> }): Promise<LedgerStorageRow>
  }
  botAgentRuntimeState: {
    findUnique(args: Record<string, unknown>): Promise<RuntimeStorageRow | null>
    update(args: {
      where: { id: number }
      data: Record<string, unknown>
    }): Promise<RuntimeStorageRow>
  }
  botAgentCheckpoint: {
    findUnique(args: Record<string, unknown>): Promise<CheckpointStorageRow | null>
    upsert(args: {
      where: { id: number }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }): Promise<CheckpointStorageRow>
  }
  $transaction<T>(task: (tx: AgentLedgerPersistenceClient) => Promise<T>): Promise<T>
}

export interface AgentRuntimePatch {
  mailboxCursors?: MailboxCursors
  mailboxContinuity?: MailboxContinuityState
  goalRevision?: number
  activeToolCapabilities?: string[]
  lastWakeAt?: Date | null
}

export interface CanonicalAgentState {
  entries: AgentLedgerEntry[]
  runtimeState: AgentRuntimeState
}

export interface AppendResult {
  appendedEntries: AgentLedgerEntry[]
  runtimeState: AgentRuntimeState
}

export interface AgentCheckpointInput {
  schemaVersion: number
  throughEntryId: bigint | null
  fingerprint: string
  projection: unknown
}

export interface StoredAgentCheckpoint extends AgentCheckpointInput {
  createdAt: Date
  updatedAt: Date
}

export interface AgentLedgerRepo {
  loadCanonicalState(): Promise<CanonicalAgentState>
  appendMessages(input: {
    messages: readonly DurableAgentMessage[]
    runtimePatch?: AgentRuntimePatch
  }): Promise<AppendResult>
  appendCompaction(input: {
    expectedHeadEntryId: bigint | null
    payload: CompactionLedgerPayload
  }): Promise<AppendResult>
  updateRuntime(input: {
    expectedHeadEntryId: bigint | null
    patch: AgentRuntimePatch
  }): Promise<AgentRuntimeState>
  saveCheckpoint(input: AgentCheckpointInput): Promise<void>
  loadCheckpoint(): Promise<StoredAgentCheckpoint | null>
}

export class AgentLedgerHeadChangedError extends Error {
  readonly expectedHeadEntryId: bigint | null
  readonly actualHeadEntryId: bigint | null

  constructor(expectedHeadEntryId: bigint | null, actualHeadEntryId: bigint | null) {
    super(
      `agent ledger head changed: expected ${formatEntryId(expectedHeadEntryId)},`
      + ` actual ${formatEntryId(actualHeadEntryId)}`,
    )
    this.name = 'AgentLedgerHeadChangedError'
    this.expectedHeadEntryId = expectedHeadEntryId
    this.actualHeadEntryId = actualHeadEntryId
  }
}

export function createAgentLedgerRepo(options: {
  client?: AgentLedgerPersistenceClient
} = {}): AgentLedgerRepo {
  const client = options.client ?? prisma as unknown as AgentLedgerPersistenceClient

  return {
    async loadCanonicalState() {
      return client.$transaction(async (tx) => {
        await lockRuntimeState(tx)
        const runtimeState = await loadRuntimeState(tx)
        const rows = await tx.botAgentLedgerEntry.findMany({ orderBy: { id: 'asc' } })
        const entries = rows.map((row, index) => parseAgentLedgerEntry(row, index))
        return { entries, runtimeState }
      })
    },

    async appendMessages(input) {
      if (input.messages.length === 0) {
        throw new AgentLedgerIntegrityError('appendMessages requires at least one message')
      }
      const messages = input.messages.map(normalizeDurableMessage)
      return client.$transaction(async (tx) => {
        await lockRuntimeState(tx)
        const current = await loadRuntimeState(tx)
        const appendedEntries: AgentLedgerEntry[] = []
        let head = current.ledgerHeadEntryId
        for (const message of messages) {
          const row = await tx.botAgentLedgerEntry.create({
            data: {
              entryType: 'message',
              payload: {
                schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
                message,
              },
            },
          })
          const entry = parseAgentLedgerEntry(row, appendedEntries.length)
          appendedEntries.push(entry)
          head = entry.id
        }
        const runtimeState = await persistRuntimeState(tx, current, input.runtimePatch, head)
        return { appendedEntries, runtimeState }
      })
    },

    async appendCompaction(input) {
      assertExpectedHead(input.expectedHeadEntryId)
      const payload = normalizeCompactionPayload(input.payload)
      return client.$transaction(async (tx) => {
        await lockRuntimeState(tx)
        const current = await loadRuntimeState(tx)
        assertMatchingHead(input.expectedHeadEntryId, current.ledgerHeadEntryId)
        const row = await tx.botAgentLedgerEntry.create({
          data: { entryType: 'compaction', payload },
        })
        const entry = parseAgentLedgerEntry(row, 0)
        const runtimeState = await persistRuntimeState(tx, current, undefined, entry.id)
        return { appendedEntries: [entry], runtimeState }
      })
    },

    async updateRuntime(input) {
      assertExpectedHead(input.expectedHeadEntryId)
      return client.$transaction(async (tx) => {
        await lockRuntimeState(tx)
        const current = await loadRuntimeState(tx)
        assertMatchingHead(input.expectedHeadEntryId, current.ledgerHeadEntryId)
        return persistRuntimeState(tx, current, input.patch, current.ledgerHeadEntryId)
      })
    },

    async saveCheckpoint(input) {
      validateCheckpointInput(input)
      const data = {
        schemaVersion: input.schemaVersion,
        throughEntryId: input.throughEntryId,
        fingerprint: input.fingerprint,
        projection: input.projection as never,
      }
      await client.botAgentCheckpoint.upsert({
        where: { id: CHECKPOINT_SINGLETON_ID },
        create: { id: CHECKPOINT_SINGLETON_ID, ...data },
        update: data,
      })
    },

    async loadCheckpoint() {
      const row = await client.botAgentCheckpoint.findUnique({
        where: { id: CHECKPOINT_SINGLETON_ID },
      })
      if (!row) return null
      if (!Number.isSafeInteger(row.schemaVersion) || row.schemaVersion < 1) {
        throw new AgentLedgerIntegrityError('checkpoint schemaVersion must be a positive safe integer')
      }
      if (row.throughEntryId !== null && (
        typeof row.throughEntryId !== 'bigint' || row.throughEntryId <= 0n
      )) {
        throw new AgentLedgerIntegrityError('checkpoint throughEntryId must be a positive bigint or null')
      }
      if (typeof row.fingerprint !== 'string' || row.fingerprint.trim() === '') {
        throw new AgentLedgerIntegrityError('checkpoint fingerprint must be a non-empty string')
      }
      if (!(row.createdAt instanceof Date) || !(row.updatedAt instanceof Date)) {
        throw new AgentLedgerIntegrityError('checkpoint timestamps must be Date values')
      }
      return {
        schemaVersion: row.schemaVersion,
        throughEntryId: row.throughEntryId,
        fingerprint: row.fingerprint,
        projection: structuredClone(row.projection),
        createdAt: new Date(row.createdAt.getTime()),
        updatedAt: new Date(row.updatedAt.getTime()),
      }
    },
  }
}

async function lockRuntimeState(client: AgentLedgerPersistenceClient): Promise<void> {
  if (client.lockRuntimeState) {
    await client.lockRuntimeState()
    return
  }
  if (!client.$queryRawUnsafe) {
    throw new Error('persistence client cannot lock bot_agent_runtime_state')
  }
  await client.$queryRawUnsafe(
    'SELECT "id" FROM "bot_agent_runtime_state" WHERE "id" = $1 FOR UPDATE',
    RUNTIME_SINGLETON_ID,
  )
}

async function loadRuntimeState(client: AgentLedgerPersistenceClient): Promise<AgentRuntimeState> {
  const row = await client.botAgentRuntimeState.findUnique({
    where: { id: RUNTIME_SINGLETON_ID },
  })
  if (!row) throw new AgentLedgerIntegrityError('bot_agent_runtime_state singleton row is missing')
  return parseAgentRuntimeState({
    schemaVersion: row.schemaVersion,
    mailboxCursors: row.mailboxCursors,
    mailboxContinuity: row.mailboxContinuity,
    goalRevision: row.goalRevision,
    activeToolCapabilities: row.activeToolCapabilities,
    lastWakeAt: row.lastWakeAt,
    ledgerHeadEntryId: row.ledgerHeadEntryId,
  })
}

async function persistRuntimeState(
  client: AgentLedgerPersistenceClient,
  current: AgentRuntimeState,
  patch: AgentRuntimePatch | undefined,
  ledgerHeadEntryId: bigint | null,
): Promise<AgentRuntimeState> {
  const next = parseAgentRuntimeState({
    ...current,
    ...definedRuntimePatch(patch),
    ledgerHeadEntryId,
  })
  const data: Record<string, unknown> = {
    ledgerHeadEntryId: next.ledgerHeadEntryId,
  }
  if (patch?.mailboxCursors !== undefined) data.mailboxCursors = next.mailboxCursors as never
  if (patch?.mailboxContinuity !== undefined) data.mailboxContinuity = next.mailboxContinuity as never
  if (patch?.goalRevision !== undefined) data.goalRevision = next.goalRevision
  if (patch?.activeToolCapabilities !== undefined) {
    data.activeToolCapabilities = next.activeToolCapabilities as never
  }
  if (patch && Object.hasOwn(patch, 'lastWakeAt')) data.lastWakeAt = next.lastWakeAt
  const row = await client.botAgentRuntimeState.update({
    where: { id: RUNTIME_SINGLETON_ID },
    data,
  })
  return parseAgentRuntimeState({
    schemaVersion: row.schemaVersion,
    mailboxCursors: row.mailboxCursors,
    mailboxContinuity: row.mailboxContinuity,
    goalRevision: row.goalRevision,
    activeToolCapabilities: row.activeToolCapabilities,
    lastWakeAt: row.lastWakeAt,
    ledgerHeadEntryId: row.ledgerHeadEntryId,
  })
}

function normalizeDurableMessage(message: DurableAgentMessage): DurableAgentMessage {
  const parsed = parseAgentLedgerEntry({
    id: 1n,
    entryType: 'message',
    payload: { schemaVersion: AGENT_LEDGER_SCHEMA_VERSION, message },
    createdAt: new Date(0),
  })
  if (parsed.entryType !== 'message') throw new AgentLedgerIntegrityError('expected message entry')
  return parsed.payload.message
}

function normalizeCompactionPayload(payload: CompactionLedgerPayload): CompactionLedgerPayload {
  const parsed = parseAgentLedgerEntry({
    id: 1n,
    entryType: 'compaction',
    payload,
    createdAt: new Date(0),
  })
  if (parsed.entryType !== 'compaction') throw new AgentLedgerIntegrityError('expected compaction entry')
  return parsed.payload
}

function definedRuntimePatch(patch: AgentRuntimePatch | undefined): AgentRuntimePatch {
  if (!patch) return {}
  const defined: AgentRuntimePatch = {}
  if (patch.mailboxCursors !== undefined) defined.mailboxCursors = patch.mailboxCursors
  if (patch.mailboxContinuity !== undefined) defined.mailboxContinuity = patch.mailboxContinuity
  if (patch.goalRevision !== undefined) defined.goalRevision = patch.goalRevision
  if (patch.activeToolCapabilities !== undefined) {
    defined.activeToolCapabilities = patch.activeToolCapabilities
  }
  if (Object.hasOwn(patch, 'lastWakeAt')) defined.lastWakeAt = patch.lastWakeAt
  return defined
}

function validateCheckpointInput(input: AgentCheckpointInput): void {
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new AgentLedgerIntegrityError('checkpoint schemaVersion must be a positive safe integer')
  }
  if (input.throughEntryId !== null && (
    typeof input.throughEntryId !== 'bigint' || input.throughEntryId <= 0n
  )) {
    throw new AgentLedgerIntegrityError('checkpoint throughEntryId must be a positive bigint or null')
  }
  if (typeof input.fingerprint !== 'string' || input.fingerprint.trim() === '') {
    throw new AgentLedgerIntegrityError('checkpoint fingerprint must be a non-empty string')
  }
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(input.projection)
  } catch (error) {
    throw new AgentLedgerIntegrityError(
      `checkpoint projection must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (serialized === undefined) {
    throw new AgentLedgerIntegrityError('checkpoint projection must be a JSON value')
  }
}

function assertExpectedHead(value: bigint | null): void {
  if (value !== null && (typeof value !== 'bigint' || value <= 0n)) {
    throw new AgentLedgerIntegrityError('expectedHeadEntryId must be a positive bigint or null')
  }
}

function assertMatchingHead(expected: bigint | null, actual: bigint | null): void {
  if (expected !== actual) throw new AgentLedgerHeadChangedError(expected, actual)
}

function formatEntryId(value: bigint | null): string {
  return value == null ? 'null' : value.toString()
}
