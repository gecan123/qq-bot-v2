import '@tanstack/react-start/server-only'
import { getAdminPrisma } from '../../server/db.server.js'
import { timelineSnapshotSchema, type TimelineSnapshot } from './timeline.schema.js'

export async function loadTimelineSnapshot(now = new Date()): Promise<TimelineSnapshot> {
  const db = getAdminPrisma()
  const [ledger, tools, tokens] = await Promise.all([
    db.botAgentLedgerEntry.findMany({ orderBy: { id: 'desc' }, take: 80 }),
    db.agentToolCall.findMany({ orderBy: [{ ts: 'desc' }, { id: 'desc' }], take: 100 }),
    db.agentTokenUsage.findMany({ orderBy: [{ ts: 'desc' }, { id: 'desc' }], take: 80 }),
  ])
  const callIds = new Set(tools.map(row => row.toolCallId))
  const events: TimelineSnapshot['events'] = [
    ...ledger.map(row => {
      const raw = compact(row.payload)
      const matchedId = [...callIds].find(id => raw.includes(id))
      return { key: `ledger-${row.id}`, at: row.createdAt.toISOString(), kind: 'ledger' as const, title: `Ledger #${row.id} · ${row.entryType}`, detail: matchedId ? `关联 toolCallId ${matchedId}` : 'Canonical payload', jsonDetail: raw, ok: null, sideEffect: null, roundIndex: null, correlation: matchedId ? 'toolCallId' as const : 'canonical' as const }
    }),
    ...tools.map(row => ({ key: `tool-${row.id}`, at: row.ts.toISOString(), kind: 'tool' as const, title: `${row.toolName} · ${row.ok ? '成功' : '失败'}`, detail: `${row.toolCallId} · ${row.durationMs}ms${row.error ? ` · ${row.error}` : ''}`, jsonDetail: pretty(row.argsSummary), ok: row.ok, sideEffect: row.sideEffect, roundIndex: row.roundIndex, correlation: 'toolCallId' as const })),
    ...tokens.map(row => ({ key: `token-${row.id}`, at: row.ts.toISOString(), kind: 'token' as const, title: `${row.operation} · ${row.model}`, detail: `${row.inputTokens ?? '—'} in · ${row.cachedTokens ?? '—'} cached · ${row.outputTokens ?? '—'} out`, jsonDetail: null, ok: null, sideEffect: null, roundIndex: row.roundIndex, correlation: 'roundIndex_best_effort' as const })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200)
  return timelineSnapshotSchema.parse({
    schemaVersion: 1, generatedAt: now.toISOString(), events,
    summary: { ledger: ledger.length, tools: tools.length, failedTools: tools.filter(row => !row.ok).length, sideEffects: tools.filter(row => row.sideEffect).length, tokenEvents: tokens.length },
    warning: 'roundIndex 会在进程重启后重新计数；只有 canonical ledger id 与 toolCallId 是可靠关联。Token 与工具按 roundIndex 的关系仅作 best-effort 诊断。',
  })
}
function compact(value: unknown): string { const rendered = pretty(value); return rendered.length > 4_000 ? `${rendered.slice(0, 4_000)}\n… [已截断]` : rendered }
function pretty(value: unknown): string { try { return JSON.stringify(value, (key, current) => /^(data|base64)$/i.test(key) && typeof current === 'string' ? `[省略 ${current.length} chars]` : current, 2) } catch { return String(value) } }
