import { prisma } from '../database/client.js'
import type { PersistedAgentSnapshot } from './agent-context.types.js'
import { SNAPSHOT_SCHEMA_VERSION } from './agent-context.types.js'
import { createLogger } from '../logger.js'

const log = createLogger('SNAPSHOT')
const SINGLE_ROW_ID = 1

export interface BotSnapshotRepo {
  load(): Promise<{ snapshot: PersistedAgentSnapshot; lastWakeAt: Date | null } | null>
  save(input: { snapshot: PersistedAgentSnapshot; lastWakeAt: Date | null }): Promise<void>
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

      lastFingerprint = JSON.stringify(persistedRaw)
      return {
        snapshot: persistedRaw,
        lastWakeAt: row.lastWakeAt ?? null,
      }
    },
    async save(input) {
      const fingerprint = JSON.stringify(input.snapshot)
      if (fingerprint === lastFingerprint) {
        return
      }
      await prisma.botAgentSnapshot.upsert({
        where: { id: SINGLE_ROW_ID },
        create: {
          id: SINGLE_ROW_ID,
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: input.snapshot as never,
          lastWakeAt: input.lastWakeAt,
        },
        update: {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          contextSnapshot: input.snapshot as never,
          lastWakeAt: input.lastWakeAt,
        },
      })
      lastFingerprint = fingerprint
    },
  }
}

function isPersistedAgentSnapshot(value: unknown): value is PersistedAgentSnapshot {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['schemaVersion'] === 'number' &&
    Array.isArray(obj['messages'])
  )
}
