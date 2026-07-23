import { timelineSnapshotSchema, type TimelineSnapshot } from './timeline.schema.js'

export interface TimelineLedgerRow {
  id: bigint
  entryType: string
  payload: unknown
  createdAt: Date
}

export interface TimelineToolRow {
  id: bigint
  ts: Date
  toolCallId: string
  toolName: string
  durationMs: number
  argsSummary: unknown
  ok: boolean
  sideEffect: boolean
  roundIndex: number
  error: string | null
}

export interface TimelineTokenRow {
  id: bigint
  ts: Date
  operation: string
  model: string
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
  roundIndex: number | null
}

export interface TimelineLlmCallRow {
  id: bigint
  callId: string
  ts: Date
  operation: string
  roundIndex: number | null
  provider: string
  model: string
  status: string
  durationMs: number
  canonicalRequest: unknown
  wireRequest: unknown
  canonicalResponse: unknown
  wireResponse: unknown
  requestId: string | null
  httpStatus: number | null
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
  stopReason: string | null
  error: string | null
}

export function buildTimelineSnapshot(input: {
  now: Date
  ledger: TimelineLedgerRow[]
  tools: TimelineToolRow[]
  tokens: TimelineTokenRow[]
  llmCalls: TimelineLlmCallRow[]
}): TimelineSnapshot {
  const callIds = new Set(input.tools.map(row => row.toolCallId))
  const events: TimelineSnapshot['events'] = [
    ...input.ledger.map(row => {
      const raw = compact(row.payload)
      const matchedId = [...callIds].find(id => raw.includes(id))
      return {
        key: `ledger-${row.id}`,
        at: row.createdAt.toISOString(),
        kind: 'ledger' as const,
        title: `Ledger #${row.id} · ${row.entryType}`,
        detail: matchedId ? `关联 toolCallId ${matchedId}` : 'Canonical payload',
        jsonDetail: raw,
        ok: null,
        sideEffect: null,
        roundIndex: null,
        correlation: matchedId ? 'toolCallId' as const : 'canonical' as const,
      }
    }),
    ...input.tools.map(row => ({
      key: `tool-${row.id}`,
      at: row.ts.toISOString(),
      kind: 'tool' as const,
      title: `${row.toolName} · ${row.ok ? '成功' : '失败'}`,
      detail: `${row.toolCallId} · ${row.durationMs}ms${row.error ? ` · ${row.error}` : ''}`,
      jsonDetail: pretty(row.argsSummary),
      ok: row.ok,
      sideEffect: row.sideEffect,
      roundIndex: row.roundIndex,
      correlation: 'toolCallId' as const,
    })),
    ...input.tokens.map(row => ({
      key: `token-${row.id}`,
      at: row.ts.toISOString(),
      kind: 'token' as const,
      title: `${row.operation} · ${row.model}`,
      detail: `${row.inputTokens ?? '—'} in · ${row.cachedTokens ?? '—'} cached · ${row.outputTokens ?? '—'} out`,
      jsonDetail: null,
      ok: null,
      sideEffect: null,
      roundIndex: row.roundIndex,
      correlation: 'roundIndex_best_effort' as const,
    })),
    ...input.llmCalls.map(row => ({
      key: `llm-${row.id}`,
      at: row.ts.toISOString(),
      kind: 'llm' as const,
      title: `${row.operation} · ${row.model}`,
      detail: `${row.provider} · ${row.status} · ${row.durationMs}ms · ${row.inputTokens ?? '—'} in · ${row.cachedTokens ?? '—'} cached · ${row.outputTokens ?? '—'} out${row.error ? ` · ${row.error}` : ''}`,
      jsonDetail: compact({
        callId: row.callId,
        requestId: row.requestId,
        httpStatus: row.httpStatus,
        stopReason: row.stopReason,
        canonicalRequest: row.canonicalRequest,
        wireRequest: row.wireRequest,
        canonicalResponse: row.canonicalResponse,
        wireResponse: row.wireResponse,
      }),
      ok: row.status === 'completed',
      sideEffect: null,
      roundIndex: row.roundIndex,
      correlation: 'llmCallId' as const,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200)

  return timelineSnapshotSchema.parse({
    schemaVersion: 2,
    generatedAt: input.now.toISOString(),
    events,
    summary: {
      ledger: input.ledger.length,
      tools: input.tools.length,
      failedTools: input.tools.filter(row => !row.ok).length,
      sideEffects: input.tools.filter(row => row.sideEffect).length,
      tokenEvents: input.tokens.length,
      llmCalls: input.llmCalls.length,
      failedLlmCalls: input.llmCalls.filter(row => row.status !== 'completed').length,
    },
    warning: 'LLM、工具和 token 记录只用于观测，不参与 canonical replay。roundIndex 跨进程仅作 best-effort 关联。',
  })
}

function compact(value: unknown): string {
  const rendered = pretty(value)
  return rendered.length > 4_000 ? `${rendered.slice(0, 4_000)}\n… [已截断]` : rendered
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (key, current) => /^(data|base64)$/i.test(key) && typeof current === 'string'
        ? `[省略 ${current.length} chars]`
        : current,
      2,
    )
  } catch {
    return String(value)
  }
}
