export interface AgentMetricsInput {
  tokenUsageNdjson: string
  toolCallsNdjson: string
  appLogNdjson?: string
}

export interface AgentMetricsFilters {
  from?: Date
  to?: Date
  toolName?: string
  operation?: string
  model?: string
  excludedModels?: readonly string[]
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
  groupEngagement: {
    byGroup: Record<string, {
      inboxReads: number
      messagesRead: number
      sendAttempts: number
      sendBlocked: number
      sendsSuccessful: number
      ambientSuccessful: number
      replySuccessful: number
      readToSendRate: number | null
    }>
  }
  malformedLines: {
    tokenUsage: number
    toolCalls: number
    appLog: number
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

interface AppLogLine {
  time?: unknown
  scope?: unknown
  msg?: unknown
  groupId?: unknown
  targetType?: unknown
  direction?: unknown
  deliveryResult?: unknown
  decision?: unknown
  mode?: unknown
  returnedMessages?: unknown
}

export function summarizeAgentMetrics(
  input: AgentMetricsInput,
  filters: AgentMetricsFilters = {},
): AgentMetricsSummary {
  const tokenSummary = summarizeTokenUsage(input.tokenUsageNdjson, filters)
  const toolSummary = summarizeToolCalls(input.toolCallsNdjson, filters)
  const engagementSummary = summarizeGroupEngagement(input.appLogNdjson ?? '', filters)
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
    groupEngagement: {
      byGroup: Object.fromEntries(
        Object.entries(engagementSummary.byGroup).map(([groupId, bucket]) => [
          groupId,
          {
            ...bucket,
            readToSendRate: bucket.inboxReads > 0
              ? round(bucket.sendsSuccessful / bucket.inboxReads)
              : null,
          },
        ]),
      ),
    },
    malformedLines: {
      tokenUsage: tokenSummary.malformed,
      toolCalls: toolSummary.malformed,
      appLog: engagementSummary.malformed,
    },
  }
}

interface MutableGroupEngagementBucket {
  inboxReads: number
  messagesRead: number
  sendAttempts: number
  sendBlocked: number
  sendsSuccessful: number
  ambientSuccessful: number
  replySuccessful: number
}

function summarizeGroupEngagement(raw: string, filters: AgentMetricsFilters): {
  byGroup: Record<string, MutableGroupEngagementBucket>
  malformed: number
} {
  const byGroup: Record<string, MutableGroupEngagementBucket> = {}
  let malformed = 0

  for (const value of parseNdjson<AppLogLine>(raw)) {
    if (!value.ok) {
      malformed++
      continue
    }
    const line = value.value
    if (!matchesTimeFilter(line.time, filters)) continue
    if (typeof line.groupId !== 'number' || !Number.isSafeInteger(line.groupId)) continue
    const groupId = String(line.groupId)

    if (line.scope === 'INBOX' && line.msg === 'inbox_group_read_completed') {
      const bucket = (byGroup[groupId] ??= createGroupEngagementBucket())
      bucket.inboxReads++
      bucket.messagesRead += numeric(line.returnedMessages)
      continue
    }
    if (
      line.scope === 'TOOL_POLICY_HOOKS'
      && line.msg === 'send_message_ai_tone_precheck'
      && line.targetType === 'group'
    ) {
      const bucket = (byGroup[groupId] ??= createGroupEngagementBucket())
      bucket.sendAttempts++
      if (line.decision === 'blocked') bucket.sendBlocked++
      continue
    }
    if (
      line.scope === 'SEND'
      && line.direction === 'outbound'
      && line.targetType === 'group'
      && line.deliveryResult === 'sent'
    ) {
      const bucket = (byGroup[groupId] ??= createGroupEngagementBucket())
      bucket.sendsSuccessful++
      if (line.mode === 'ambient') bucket.ambientSuccessful++
      if (line.mode === 'reply') bucket.replySuccessful++
    }
  }

  return { byGroup, malformed }
}

function createGroupEngagementBucket(): MutableGroupEngagementBucket {
  return {
    inboxReads: 0,
    messagesRead: 0,
    sendAttempts: 0,
    sendBlocked: 0,
    sendsSuccessful: 0,
    ambientSuccessful: 0,
    replySuccessful: 0,
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
  const excludedModels = new Set(resolveExcludedMetricModels(filters))

  for (const value of parseNdjson<TokenUsageLine>(raw)) {
    if (!value.ok) {
      malformed++
      continue
    }
    const line = value.value
    if (!matchesTimeFilter(line.ts, filters)) continue
    if (filters.operation && line.operation !== filters.operation) continue
    if (filters.model && line.model !== filters.model) continue
    if (typeof line.model === 'string' && excludedModels.has(line.model)) continue

    const operation = typeof line.operation === 'string' && line.operation.length > 0
      ? line.operation
      : 'unknown'
    const bucket = (byOperation[operation] ??= createTokenBucket())
    addTokenLine(total, line)
    addTokenLine(bucket, line)
  }

  return { total, byOperation, malformed }
}

export function resolveExcludedMetricModels(filters: AgentMetricsFilters): readonly string[] {
  if (filters.model) return []
  return filters.excludedModels ?? ['mock']
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
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)
    ? `${ts.replace(' ', 'T')}+08:00`
    : ts
  const time = Date.parse(normalized)
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
