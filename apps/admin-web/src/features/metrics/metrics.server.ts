import '@tanstack/react-start/server-only'
import { getAdminPrisma } from '../../server/db.server.js'
import { metricsSnapshotSchema, type MetricsSnapshot } from './metrics.schema.js'

export async function loadMetricsSnapshot(now = new Date()): Promise<MetricsSnapshot> {
  const from = new Date(now.getTime() - 7 * 86_400_000)
  const db = getAdminPrisma()
  const [tools, tokens] = await Promise.all([
    db.agentToolCall.findMany({ where: { ts: { gte: from, lte: now } }, orderBy: { ts: 'asc' }, take: 20_000 }),
    db.agentTokenUsage.findMany({ where: { ts: { gte: from, lte: now } }, orderBy: { ts: 'asc' }, take: 20_000 }),
  ])
  const input = sum(tokens, row => row.inputTokens ?? 0), cached = sum(tokens, row => row.cachedTokens ?? 0), output = sum(tokens, row => row.outputTokens ?? 0)
  const days = new Map<string, { day: string; tools: number; failed: number; input: number; cached: number; output: number }>()
  for (let cursor = new Date(from); cursor <= now; cursor = new Date(cursor.getTime() + 86_400_000)) { const day = cursor.toISOString().slice(0, 10); days.set(day, { day, tools: 0, failed: 0, input: 0, cached: 0, output: 0 }) }
  for (const row of tools) { const bucket = days.get(row.ts.toISOString().slice(0, 10)); if (bucket) { bucket.tools++; if (!row.ok) bucket.failed++ } }
  for (const row of tokens) { const bucket = days.get(row.ts.toISOString().slice(0, 10)); if (bucket) { bucket.input += row.inputTokens ?? 0; bucket.cached += row.cachedTokens ?? 0; bucket.output += row.outputTokens ?? 0 } }
  return metricsSnapshotSchema.parse({
    schemaVersion: 1, generatedAt: now.toISOString(), window: { from: from.toISOString(), to: now.toISOString() },
    totals: { toolCalls: tools.length, failedTools: tools.filter(row => !row.ok).length, sideEffects: tools.filter(row => row.sideEffect).length, inputTokens: input, cachedTokens: cached, outputTokens: output, cacheHitRate: input > 0 ? cached / input : null },
    days: [...days.values()].slice(-7), tools: groupTools(tools), operations: groupTokens(tokens, row => row.operation), models: groupTokens(tokens, row => row.model),
  })
}
function sum<T>(rows: T[], pick: (row: T) => number): number { return rows.reduce((total, row) => total + pick(row), 0) }
function groupTools(rows: Array<{ toolName: string; ok: boolean; sideEffect: boolean; durationMs: number }>): MetricsSnapshot['tools'] { const groups = new Map<string, typeof rows>(); for (const row of rows) groups.set(row.toolName, [...(groups.get(row.toolName) ?? []), row]); return [...groups].map(([name, items]) => { const sorted = items.map(item => item.durationMs).sort((a, b) => a - b); return { name, calls: items.length, failed: items.filter(item => !item.ok).length, sideEffects: items.filter(item => item.sideEffect).length, avgMs: Math.round(sum(items, item => item.durationMs) / items.length), p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? 0, maxMs: sorted.at(-1) ?? 0 } }).sort((a, b) => b.calls - a.calls) }
function groupTokens<T extends { inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null }>(rows: T[], key: (row: T) => string): MetricsSnapshot['operations'] { const groups = new Map<string, T[]>(); for (const row of rows) { const name = key(row); groups.set(name, [...(groups.get(name) ?? []), row]) } return [...groups].map(([name, items]) => { const input = sum(items, item => item.inputTokens ?? 0); const cached = sum(items, item => item.cachedTokens ?? 0); return { name, calls: items.length, input, cached, output: sum(items, item => item.outputTokens ?? 0), cacheHitRate: input > 0 ? cached / input : null } }).sort((a, b) => b.input - a.input) }
