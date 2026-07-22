import '@tanstack/react-start/server-only'
import { getAdminPrisma } from '../../server/db.server.js'
import { contextSnapshotSchema, type ContextSnapshot } from './context.schema.js'

export async function loadContextSnapshot(now = new Date()): Promise<ContextSnapshot> {
  const db = getAdminPrisma()
  const [total, rows, grouped, checkpoint, runtime, usage] = await Promise.all([
    db.botAgentLedgerEntry.count(),
    db.botAgentLedgerEntry.findMany({ orderBy: { id: 'desc' }, take: 80 }),
    db.botAgentLedgerEntry.groupBy({ by: ['entryType'], _count: { _all: true }, orderBy: { _count: { entryType: 'desc' } } }),
    db.botAgentCheckpoint.findUnique({ where: { id: 1 }, select: { throughEntryId: true, updatedAt: true } }),
    db.botAgentRuntimeState.findUnique({ where: { id: 1 }, select: { ledgerHeadEntryId: true, goalRevision: true, updatedAt: true } }),
    db.agentTokenUsage.findFirst({ where: { operation: 'agent.chat' }, orderBy: [{ ts: 'desc' }, { id: 'desc' }] }),
  ])
  const warnings: string[] = []
  const headId = rows[0]?.id.toString() ?? null
  const runtimeHeadId = runtime?.ledgerHeadEntryId?.toString() ?? null
  if (headId !== runtimeHeadId) warnings.push(`Runtime head (${runtimeHeadId ?? '空'}) 与 ledger head (${headId ?? '空'}) 不一致。`)
  if (checkpoint?.throughEntryId && headId && checkpoint.throughEntryId > BigInt(headId)) warnings.push('Checkpoint throughEntryId 超过 canonical ledger head。')

  return contextSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    ledger: {
      total,
      headId,
      checkpointThroughId: checkpoint?.throughEntryId?.toString() ?? null,
      checkpointUpdatedAt: checkpoint?.updatedAt.toISOString() ?? null,
      typeCounts: grouped.map(item => ({ type: item.entryType, count: item._count._all })),
    },
    runtime: {
      ledgerHeadId: runtimeHeadId,
      goalRevision: runtime?.goalRevision ?? null,
      updatedAt: runtime?.updatedAt.toISOString() ?? null,
    },
    latestUsage: usage === null ? null : {
      ts: usage.ts.toISOString(), model: usage.model, inputTokens: usage.inputTokens,
      cachedTokens: usage.cachedTokens, outputTokens: usage.outputTokens, cacheHitRate: usage.cacheHitRate,
    },
    entries: rows.map(row => ({
      id: row.id.toString(), entryType: row.entryType, createdAt: row.createdAt.toISOString(),
      role: readRole(row.payload), preview: safePreview(row.payload),
    })),
    warnings,
  })
}

function readRole(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.role === 'string') return record.role
  const message = record.message
  return message && typeof message === 'object' && typeof (message as Record<string, unknown>).role === 'string'
    ? String((message as Record<string, unknown>).role) : null
}

function safePreview(value: unknown): string {
  const seen = new WeakSet<object>()
  const raw = JSON.stringify(value, (key, current) => {
    if (/^(data|imageData|audioData|base64)$/i.test(key) && typeof current === 'string') return `[省略 ${current.length} chars]`
    if (typeof current === 'string' && current.length > 600) return `${current.slice(0, 600)}…`
    if (current && typeof current === 'object') {
      if (seen.has(current)) return '[Circular]'
      seen.add(current)
    }
    return current
  }, 2)
  const rendered = raw ?? String(value)
  return rendered.length > 4_000 ? `${rendered.slice(0, 4_000)}\n… [已截断]` : rendered
}
