import { prisma } from '../database/client.js'
import type { PersistedAgentSnapshot } from './agent-context.types.js'
import { SNAPSHOT_SCHEMA_VERSION } from './agent-context.types.js'
import { createLogger } from '../logger.js'
import type { MailboxCursors } from './mailbox.js'
import {
  parseMailboxContinuityState,
  type MailboxContinuityState,
} from './mailbox-continuity.js'
import { validateBotSnapshotIntegrity } from './snapshot-integrity.js'

const log = createLogger('SNAPSHOT')
const SINGLE_ROW_ID = 1
const MAX_CHECKPOINTS = 3

type RawPersistedAgentSnapshot = {
  schemaVersion: number
  messages: PersistedAgentSnapshot['messages']
  activeToolCapabilities?: unknown
  qqConversationFocus: PersistedAgentSnapshot['qqConversationFocus']
}

interface SnapshotStorageRow {
  id?: number | bigint
  schemaVersion: number
  contextSnapshot: unknown
  mailboxCursors: unknown
  mailboxContinuity: unknown
  goalRevision: number
  lastWakeAt: Date | null
  createdAt?: Date
}

export interface SnapshotPersistenceClient {
  botAgentSnapshot: {
    findUnique(args: Record<string, unknown>): Promise<SnapshotStorageRow | null>
    upsert(args: Record<string, unknown>): Promise<SnapshotStorageRow>
  }
  botAgentSnapshotCheckpoint: {
    findMany(args: Record<string, unknown>): Promise<SnapshotStorageRow[] | Array<{ id: bigint }>>
    create(args: Record<string, unknown>): Promise<SnapshotStorageRow>
    deleteMany(args: Record<string, unknown>): Promise<{ count: number }>
  }
  $transaction<T>(task: (tx: SnapshotPersistenceClient) => Promise<T>): Promise<T>
}

export class SnapshotIntegrityError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(`snapshot integrity validation failed: ${errors.join('; ')}`)
    this.name = 'SnapshotIntegrityError'
    this.errors = [...errors]
  }
}

interface LoadedSnapshot {
  snapshot: PersistedAgentSnapshot
  mailboxCursors: MailboxCursors
  mailboxContinuity: MailboxContinuityState
  goalRevision: number
  lastWakeAt: Date | null
  recoveredFromCheckpoint: boolean
}

export interface BotSnapshotRepo {
  load(): Promise<LoadedSnapshot | null>
  save(input: {
    snapshot: PersistedAgentSnapshot
    mailboxCursors: MailboxCursors
    mailboxContinuity?: MailboxContinuityState
    goalRevision: number
    lastWakeAt: Date | null
  }): Promise<void>
}

export function createBotSnapshotRepo(options?: { client?: SnapshotPersistenceClient }): BotSnapshotRepo {
  const client = options?.client ?? prisma as unknown as SnapshotPersistenceClient
  let lastFingerprint: string | null = null

  return {
    async load() {
      const row = await client.botAgentSnapshot.findUnique({
        where: { id: SINGLE_ROW_ID },
      })
      if (!row) return null

      const current = validateStorageRow(row, 'current')
      if (current.loaded) {
        lastFingerprint = fingerprint(current.loaded)
        return { ...current.loaded, recoveredFromCheckpoint: false }
      }

      const checkpoints = await client.botAgentSnapshotCheckpoint.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      const errors = [...current.errors]
      for (const [index, checkpoint] of (checkpoints as SnapshotStorageRow[]).entries()) {
        const candidate = validateStorageRow(checkpoint, `checkpoint[${index}]`)
        if (candidate.loaded) {
          log.warn({ checkpointId: checkpoint.id?.toString(), currentErrors: current.errors }, 'snapshot_checkpoint_recovered')
          lastFingerprint = null
          return { ...candidate.loaded, recoveredFromCheckpoint: true }
        }
        errors.push(...candidate.errors)
      }
      if (checkpoints.length === 0) errors.push('checkpoint: none available')
      throw new SnapshotIntegrityError(errors)
    },
    async save(input) {
      const normalized = {
        snapshot: input.snapshot,
        mailboxCursors: input.mailboxCursors,
        mailboxContinuity: input.mailboxContinuity ?? parseMailboxContinuityState({}),
        goalRevision: input.goalRevision,
        lastWakeAt: input.lastWakeAt,
      }
      const validation = validateBotSnapshotIntegrity({
        snapshot: normalized.snapshot,
        mailboxCursors: normalized.mailboxCursors,
        mailboxContinuity: normalized.mailboxContinuity,
        goalRevision: normalized.goalRevision,
      })
      if (!validation.ok) throw new SnapshotIntegrityError(validation.errors.map((error) => `save: ${error}`))

      const nextFingerprint = fingerprint(normalized)
      if (nextFingerprint === lastFingerprint) return

      await client.$transaction(async (tx) => {
        const currentRow = await tx.botAgentSnapshot.findUnique({ where: { id: SINGLE_ROW_ID } })
        if (currentRow) {
          const current = validateStorageRow(currentRow, 'current-before-save')
          if (current.loaded && fingerprint(current.loaded) === nextFingerprint) return
          if (current.loaded) {
            await tx.botAgentSnapshotCheckpoint.create({
              data: checkpointData(currentRow),
            })
          } else {
            log.warn({ errors: current.errors }, 'invalid_current_snapshot_overwritten_from_valid_runtime')
          }
        }

        const data = {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: normalized.snapshot as never,
          mailboxCursors: normalized.mailboxCursors as never,
          mailboxContinuity: normalized.mailboxContinuity as never,
          goalRevision: normalized.goalRevision,
          lastWakeAt: normalized.lastWakeAt,
        }
        await tx.botAgentSnapshot.upsert({
          where: { id: SINGLE_ROW_ID },
          create: { id: SINGLE_ROW_ID, ...data },
          update: data,
        })

        const stale = await tx.botAgentSnapshotCheckpoint.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: MAX_CHECKPOINTS,
          select: { id: true },
        }) as Array<{ id: bigint }>
        if (stale.length > 0) {
          await tx.botAgentSnapshotCheckpoint.deleteMany({
            where: { id: { in: stale.map((item) => item.id) } },
          })
        }
      })
      lastFingerprint = nextFingerprint
    },
  }
}

function validateStorageRow(row: SnapshotStorageRow, label: string): {
  loaded: Omit<LoadedSnapshot, 'recoveredFromCheckpoint'> | null
  errors: string[]
} {
  if (!isPersistedAgentSnapshot(row.contextSnapshot)) {
    return { loaded: null, errors: [`${label}: contextSnapshot has invalid shape`] }
  }
  const snapshot = migrateSnapshot(row.contextSnapshot)
  const validation = validateBotSnapshotIntegrity({
    snapshot,
    mailboxCursors: row.mailboxCursors,
    mailboxContinuity: row.mailboxContinuity,
    goalRevision: row.goalRevision,
  })
  if (!validation.ok) {
    return { loaded: null, errors: validation.errors.map((error) => `${label}: ${error}`) }
  }
  if (row.lastWakeAt != null && !(row.lastWakeAt instanceof Date)) {
    return { loaded: null, errors: [`${label}: lastWakeAt must be Date or null`] }
  }
  return {
    loaded: {
      snapshot,
      mailboxCursors: parseMailboxCursors(row.mailboxCursors),
      mailboxContinuity: parseMailboxContinuityState(row.mailboxContinuity),
      goalRevision: parseGoalRevision(row.goalRevision),
      lastWakeAt: row.lastWakeAt ?? null,
    },
    errors: [],
  }
}

function checkpointData(row: SnapshotStorageRow): Record<string, unknown> {
  return {
    schemaVersion: row.schemaVersion,
    contextSnapshot: row.contextSnapshot as never,
    mailboxCursors: row.mailboxCursors as never,
    mailboxContinuity: row.mailboxContinuity as never,
    goalRevision: row.goalRevision,
    lastWakeAt: row.lastWakeAt,
  }
}

function fingerprint(input: Omit<LoadedSnapshot, 'recoveredFromCheckpoint'>): string {
  return JSON.stringify({
    snapshot: input.snapshot,
    mailboxCursors: input.mailboxCursors,
    mailboxContinuity: input.mailboxContinuity,
    goalRevision: input.goalRevision,
    lastWakeAtMs: input.lastWakeAt?.getTime() ?? null,
  })
}

function parseGoalRevision(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
}

function parseMailboxCursors(value: unknown): MailboxCursors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const cursors: MailboxCursors = {}
  for (const [key, rawCursor] of Object.entries(value)) {
    if (!/^qq_(?:group|private):\d+$/.test(key)) continue
    if (!Number.isSafeInteger(rawCursor) || (rawCursor as number) < 0) continue
    cursors[key] = rawCursor as number
  }
  return cursors
}

function migrateSnapshot(raw: RawPersistedAgentSnapshot): PersistedAgentSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    messages: raw.messages,
    activeToolCapabilities: sanitizeToolCapabilities(raw.activeToolCapabilities),
    qqConversationFocus: raw.qqConversationFocus,
  }
}

function isPersistedAgentSnapshot(value: unknown): value is RawPersistedAgentSnapshot {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['schemaVersion'] === 'number' &&
    Array.isArray(obj['messages']) &&
    Object.prototype.hasOwnProperty.call(obj, 'qqConversationFocus')
  )
}

function sanitizeToolCapabilities(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const output: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const capability = item.trim()
    if (!capability || seen.has(capability)) continue
    seen.add(capability)
    output.push(capability)
  }
  return output
}
