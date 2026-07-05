import { prisma } from '../database/client.js'
import type { PersistedAgentSnapshot } from './agent-context.types.js'
import { SNAPSHOT_SCHEMA_VERSION } from './agent-context.types.js'
import { createLogger } from '../logger.js'
import type { MailboxCursors } from './mailbox.js'

const log = createLogger('SNAPSHOT')
const SINGLE_ROW_ID = 1

type RawPersistedAgentSnapshot = {
  schemaVersion: number
  messages: PersistedAgentSnapshot['messages']
  activeToolCapabilities?: unknown
}

export interface BotSnapshotRepo {
  load(): Promise<{
    snapshot: PersistedAgentSnapshot
    mailboxCursors: MailboxCursors
    lastWakeAt: Date | null
  } | null>
  save(input: {
    snapshot: PersistedAgentSnapshot
    mailboxCursors: MailboxCursors
    lastWakeAt: Date | null
  }): Promise<void>
}

export function createBotSnapshotRepo(): BotSnapshotRepo {
  let lastFingerprint: string | null = null

  return {
    async load() {
      const row = await prisma.botAgentSnapshot.findUnique({
        where: { id: SINGLE_ROW_ID },
      })
      if (!row) return null

      const persistedRaw = row.contextSnapshot as unknown
      if (!isPersistedAgentSnapshot(persistedRaw)) {
        log.warn({ schemaVersion: row.schemaVersion }, 'snapshot 形态异常,忽略,从空开始')
        return null
      }

      const migrated = migrateSnapshot(persistedRaw)
      lastFingerprint = JSON.stringify(migrated)
      return {
        snapshot: migrated,
        mailboxCursors: parseMailboxCursors(row.mailboxCursors),
        lastWakeAt: row.lastWakeAt ?? null,
      }
    },
    async save(input) {
      const fingerprint = JSON.stringify({
        snapshot: input.snapshot,
        mailboxCursors: input.mailboxCursors,
        lastWakeAt: input.lastWakeAt?.toISOString() ?? null,
      })
      if (fingerprint === lastFingerprint) {
        return
      }
      await prisma.botAgentSnapshot.upsert({
        where: { id: SINGLE_ROW_ID },
        create: {
          id: SINGLE_ROW_ID,
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: input.snapshot as never,
          mailboxCursors: input.mailboxCursors as never,
          lastWakeAt: input.lastWakeAt,
        },
        update: {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: input.snapshot as never,
          mailboxCursors: input.mailboxCursors as never,
          lastWakeAt: input.lastWakeAt,
        },
      })
      lastFingerprint = fingerprint
    },
  }
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
  }
}

function isPersistedAgentSnapshot(value: unknown): value is RawPersistedAgentSnapshot {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['schemaVersion'] === 'number' &&
    Array.isArray(obj['messages'])
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
