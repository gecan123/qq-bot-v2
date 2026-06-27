export interface AgentMetricsInput {
  tokenUsageNdjson: string
  toolCallsNdjson: string
}

export interface AgentMetricsFilters {
  from?: Date
  to?: Date
  toolName?: string
  operation?: string
  model?: string
  ok?: boolean
  sideEffect?: boolean
}

export interface TokenUsageBucket {
  entries: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  cacheHitRate: number | null
}

export interface AgentMetricsSummary {
  tokenUsage: {
    total: TokenUsageBucket
    byOperation: Record<string, TokenUsageBucket>
  }
  toolCalls: {
    total: number
    failed: number
    sideEffects: number
    sideEffectsByTool: Record<string, number>
    byTool: Record<string, {
      calls: number
      failed: number
      sideEffects: number
      avgDurationMs: number | null
      failedRate: number
      sideEffectRate: number
    }>
  }
  malformedLines: {
    tokenUsage: number
    toolCalls: number
  }
}

interface TokenUsageLine {
  ts?: unknown
  operation?: unknown
  model?: unknown
  inputTokens?: unknown
  cachedTokens?: unknown
  outputTokens?: unknown
}

interface ToolCallLine {
  ts?: unknown
  toolName?: unknown
  ok?: unknown
  sideEffect?: unknown
  durationMs?: unknown
}

export function summarizeAgentMetrics(
  input: AgentMetricsInput,
  filters: AgentMetricsFilters = {},
): AgentMetricsSummary {
  const tokenSummary = summarizeTokenUsage(input.tokenUsageNdjson, filters)
  const toolSummary = summarizeToolCalls(input.toolCallsNdjson, filters)
  return {
    tokenUsage: {
      total: finalizeTokenBucket(tokenSummary.total),
      byOperation: Object.fromEntries(
        Object.entries(tokenSummary.byOperation).map(([operation, bucket]) => [
          operation,
          finalizeTokenBucket(bucket),
        ]),
      ),
    },
    toolCalls: {
      total: toolSummary.total,
      failed: toolSummary.failed,
      sideEffects: toolSummary.sideEffects,
      sideEffectsByTool: Object.fromEntries(
        Object.entries(toolSummary.byTool)
          .filter(([, bucket]) => bucket.sideEffects > 0)
          .map(([toolName, bucket]) => [toolName, bucket.sideEffects]),
      ),
      byTool: Object.fromEntries(
        Object.entries(toolSummary.byTool).map(([toolName, bucket]) => [
          toolName,
          {
            calls: bucket.calls,
            failed: bucket.failed,
            sideEffects: bucket.sideEffects,
            avgDurationMs: bucket.calls > 0 ? round(bucket.durationMs / bucket.calls) : null,
            failedRate: bucket.calls > 0 ? round(bucket.failed / bucket.calls) : 0,
            sideEffectRate: bucket.calls > 0 ? round(bucket.sideEffects / bucket.calls) : 0,
          },
        ]),
      ),
    },
    malformedLines: {
      tokenUsage: tokenSummary.malformed,
      toolCalls: toolSummary.malformed,
    },
  }
}

function summarizeTokenUsage(raw: string, filters: AgentMetricsFilters): {
  total: MutableTokenBucket
  byOperation: Record<string, MutableTokenBucket>
  malformed: number
} {
  const total = createTokenBucket()
  const byOperation: Record<string, MutableTokenBucket> = {}
  let malformed = 0

  for (const value of parseNdjson<TokenUsageLine>(raw)) {
    if (!value.ok) {
      malformed++
      continue
    }
    const line = value.value
    if (!matchesTimeFilter(line.ts, filters)) continue
    if (filters.operation && line.operation !== filters.operation) continue
    if (filters.model && line.model !== filters.model) continue

    const operation = typeof line.operation === 'string' && line.operation.length > 0
      ? line.operation
      : 'unknown'
    const bucket = (byOperation[operation] ??= createTokenBucket())
    addTokenLine(total, line)
    addTokenLine(bucket, line)
  }

  return { total, byOperation, malformed }
}

function summarizeToolCalls(raw: string, filters: AgentMetricsFilters): {
  total: number
  failed: number
  sideEffects: number
  byTool: Record<string, MutableToolBucket>
  malformed: number
} {
  const byTool: Record<string, MutableToolBucket> = {}
  let total = 0
  let failed = 0
  let sideEffects = 0
  let malformed = 0

  for (const value of parseNdjson<ToolCallLine>(raw)) {
    if (!value.ok) {
      malformed++
      continue
    }
    const line = value.value
    if (!matchesTimeFilter(line.ts, filters)) continue
    if (filters.toolName && line.toolName !== filters.toolName) continue
    if (filters.ok != null && line.ok !== filters.ok) continue
    if (filters.sideEffect != null && line.sideEffect !== filters.sideEffect) continue

    const toolName = typeof line.toolName === 'string' && line.toolName.length > 0
      ? line.toolName
      : 'unknown'
    const bucket = (byTool[toolName] ??= { calls: 0, failed: 0, sideEffects: 0, durationMs: 0 })
    const ok = line.ok === true
    const durationMs = typeof line.durationMs === 'number' && Number.isFinite(line.durationMs)
      ? line.durationMs
      : 0

    total++
    bucket.calls++
    bucket.durationMs += durationMs
    if (!ok) {
      failed++
      bucket.failed++
    }
    if (line.sideEffect === true) {
      sideEffects++
      bucket.sideEffects++
    }
  }

  return { total, failed, sideEffects, byTool, malformed }
}

interface MutableTokenBucket {
  entries: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
}

interface MutableToolBucket {
  calls: number
  failed: number
  sideEffects: number
  durationMs: number
}

function createTokenBucket(): MutableTokenBucket {
  return { entries: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 }
}

function addTokenLine(bucket: MutableTokenBucket, line: TokenUsageLine): void {
  bucket.entries++
  bucket.inputTokens += numeric(line.inputTokens)
  bucket.cachedTokens += numeric(line.cachedTokens)
  bucket.outputTokens += numeric(line.outputTokens)
}

function finalizeTokenBucket(bucket: MutableTokenBucket): TokenUsageBucket {
  return {
    entries: bucket.entries,
    inputTokens: bucket.inputTokens,
    cachedTokens: bucket.cachedTokens,
    outputTokens: bucket.outputTokens,
    cacheHitRate: bucket.inputTokens > 0 ? round(bucket.cachedTokens / bucket.inputTokens) : null,
  }
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function matchesTimeFilter(ts: unknown, filters: AgentMetricsFilters): boolean {
  if (!filters.from && !filters.to) return true
  if (typeof ts !== 'string') return false
  const time = Date.parse(ts)
  if (!Number.isFinite(time)) return false
  if (filters.from && time < filters.from.getTime()) return false
  if (filters.to && time > filters.to.getTime()) return false
  return true
}

function* parseNdjson<T>(raw: string): Generator<{ ok: true; value: T } | { ok: false }> {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        yield { ok: false }
        continue
      }
      yield { ok: true, value: parsed as T }
    } catch {
      yield { ok: false }
    }
  }
}
