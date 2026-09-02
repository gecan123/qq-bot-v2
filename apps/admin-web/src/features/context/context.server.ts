import '@tanstack/react-start/server-only'
import { readLiveAgentActivity } from '../../server/agent-activity.server.js'
import { getAdminPrisma } from '../../server/db.server.js'
import { mapLiveAgentActivity } from '../activity/activity.service.js'
import {
  contextSnapshotSchema,
  contextThinkingArchiveSchema,
  contextThinkingBlockSchema,
  type ContextSnapshot,
  type ContextThinkingArchive,
  type ContextThinkingBlock,
  type ContextThinkingBlockInput,
} from './context.schema.js'

const CONVERSATION_TEXT_LIMIT = 12_000

export async function loadContextSnapshot(now = new Date()): Promise<ContextSnapshot> {
  const db = getAdminPrisma()
  const [total, rows, grouped, checkpoint, runtime, usage, recentLlmCalls, activityInput] = await Promise.all([
    db.botAgentLedgerEntry.count(),
    db.botAgentLedgerEntry.findMany({ orderBy: { id: 'desc' }, take: 80 }),
    db.botAgentLedgerEntry.groupBy({ by: ['entryType'], _count: { _all: true }, orderBy: { _count: { entryType: 'desc' } } }),
    db.botAgentCheckpoint.findUnique({ where: { id: 1 }, select: { throughEntryId: true, updatedAt: true } }),
    db.botAgentRuntimeState.findUnique({ where: { id: 1 }, select: { ledgerHeadEntryId: true, updatedAt: true } }),
    db.agentTokenUsage.findFirst({
      where: { operation: 'agent.chat', status: 'succeeded' },
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
    }),
    db.agentTokenUsage.findMany({
      where: { callId: { not: null } },
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      take: 30,
      select: {
        callId: true,
        ts: true,
        operation: true,
        actor: true,
        provider: true,
        model: true,
        status: true,
        durationMs: true,
        stopReason: true,
        errorKind: true,
        inputTokens: true,
        cachedTokens: true,
        outputTokens: true,
        evidence: true,
      },
    }),
    readLiveAgentActivity(),
  ])
  const warnings: string[] = []
  const headId = rows[0]?.id.toString() ?? null
  const runtimeHeadId = runtime?.ledgerHeadEntryId?.toString() ?? null
  if (headId !== runtimeHeadId) warnings.push(`Runtime head (${runtimeHeadId ?? '空'}) 与 ledger head (${headId ?? '空'}) 不一致。`)
  if (checkpoint?.throughEntryId && headId && checkpoint.throughEntryId > BigInt(headId)) warnings.push('Checkpoint throughEntryId 超过 canonical ledger head。')
  if (activityInput.status === 'invalid') warnings.push('实时活动观察面无效。')
  if (activityInput.status === 'stale') warnings.push('实时活动观察面属于已停止或不可达的 Bot 进程。')

  return contextSnapshotSchema.parse({
    schemaVersion: 7,
    generatedAt: now.toISOString(),
    activity: mapLiveAgentActivity(activityInput),
    ledger: {
      total,
      headId,
      checkpointThroughId: checkpoint?.throughEntryId?.toString() ?? null,
      checkpointUpdatedAt: checkpoint?.updatedAt.toISOString() ?? null,
      typeCounts: grouped.map(item => ({ type: item.entryType, count: item._count._all })),
    },
    runtime: {
      ledgerHeadId: runtimeHeadId,
      updatedAt: runtime?.updatedAt.toISOString() ?? null,
    },
    latestUsage: usage === null ? null : {
      ts: usage.ts.toISOString(), model: usage.model, inputTokens: usage.inputTokens,
      cachedTokens: usage.cachedTokens, outputTokens: usage.outputTokens, cacheHitRate: usage.cacheHitRate,
    },
    recentLlmCalls: recentLlmCalls.flatMap(row => row.callId === null ? [] : [{
      callId: row.callId,
      ts: row.ts.toISOString(),
      operation: row.operation,
      actor: row.actor,
      provider: row.provider,
      model: row.model,
      status: normalizeCallStatus(row.status),
      durationMs: row.durationMs,
      stopReason: row.stopReason,
      errorKind: row.errorKind,
      inputTokens: row.inputTokens,
      cachedTokens: row.cachedTokens,
      outputTokens: row.outputTokens,
      evidence: readEvidence(row.evidence),
    }]),
    entries: buildContextEntryViews(rows),
    warnings,
  })
}

function normalizeCallStatus(value: string): 'succeeded' | 'failed' | 'aborted' {
  return value === 'failed' || value === 'aborted' ? value : 'succeeded'
}

function readEvidence(value: unknown): ContextSnapshot['recentLlmCalls'][number]['evidence'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return {
    canonicalRequest: readEvidenceDigest(record.canonicalRequest),
    providerRequest: readEvidenceDigest(record.providerRequest),
    providerResponse: readEvidenceDigest(record.providerResponse),
    canonicalResponse: readEvidenceDigest(record.canonicalResponse),
  }
}

function readEvidenceDigest(
  value: unknown,
): NonNullable<ContextSnapshot['recentLlmCalls'][number]['evidence']>['canonicalRequest'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint)) {
    return null
  }
  const summary = record.summary
  const candidates = summary && typeof summary === 'object' && !Array.isArray(summary)
    ? (summary as Record<string, unknown>).toolNames
    : null
  const toolNames = Array.isArray(candidates)
    ? candidates.filter((item): item is string => typeof item === 'string').slice(0, 64)
    : []
  return { fingerprint: record.fingerprint, toolNames }
}

export interface ContextLedgerRow {
  id: bigint
  entryType: string
  payload: unknown
  createdAt: Date
}

export interface ContextThinkingIndexRow {
  entryId: bigint
  createdAt: Date
  blockIndex: number
  type: 'thinking' | 'redacted_thinking'
  charCount: number
}

export async function loadContextThinkingArchive(): Promise<ContextThinkingArchive> {
  const db = getAdminPrisma()
  const rows = await db.$queryRaw<ContextThinkingIndexRow[]>`
    SELECT
      entry.id AS "entryId",
      entry.created_at AS "createdAt",
      (block.ordinality - 1)::integer AS "blockIndex",
      block.value->>'type' AS "type",
      character_length(COALESCE(block.value->>'thinking', ''))::integer AS "charCount"
    FROM bot_agent_ledger_entries AS entry
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(entry.payload #> '{message,nativeBlocks}') = 'array'
          THEN entry.payload #> '{message,nativeBlocks}'
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS block(value, ordinality)
    WHERE entry.entry_type = 'message'
      AND entry.payload #>> '{message,role}' = 'assistant'
      AND block.value->>'type' IN ('thinking', 'redacted_thinking')
    ORDER BY entry.id DESC, block.ordinality ASC
  `
  return buildContextThinkingArchive(rows)
}

export async function loadContextThinkingBlock(
  input: ContextThinkingBlockInput,
): Promise<ContextThinkingBlock> {
  const db = getAdminPrisma()
  const row = await db.botAgentLedgerEntry.findUnique({
    where: { id: BigInt(input.entryId) },
    select: { payload: true },
  })
  if (!row) throw new Error('Thinking block 不存在。')
  return readContextThinkingBlockPayload(row.payload, input)
}

export function buildContextThinkingArchive(
  rows: readonly ContextThinkingIndexRow[],
): ContextThinkingArchive {
  const entries = new Map<string, ContextThinkingArchive['entries'][number]>()
  for (const row of rows) {
    const entryId = row.entryId.toString()
    const entry = entries.get(entryId) ?? {
      entryId,
      createdAt: row.createdAt.toISOString(),
      blocks: [],
    }
    entry.blocks.push({
      blockIndex: row.blockIndex,
      type: row.type,
      charCount: row.charCount,
    })
    entries.set(entryId, entry)
  }
  return contextThinkingArchiveSchema.parse({ schemaVersion: 1, entries: [...entries.values()] })
}

export function readContextThinkingBlockPayload(
  payload: unknown,
  input: ContextThinkingBlockInput,
): ContextThinkingBlock {
  const payloadRecord = asRecord(payload)
  if (payloadRecord?.schemaVersion !== 1) throw new Error('Thinking block 不存在。')
  const message = asRecord(payloadRecord?.message)
  const blocks = message?.role === 'assistant' && Array.isArray(message.nativeBlocks)
    ? message.nativeBlocks
    : null
  const block = blocks === null ? null : asRecord(blocks[input.blockIndex])
  if (!block || (block.type !== 'thinking' && block.type !== 'redacted_thinking')) {
    throw new Error('Thinking block 不存在。')
  }
  return contextThinkingBlockSchema.parse({
    schemaVersion: 1,
    entryId: input.entryId,
    blockIndex: input.blockIndex,
    type: block.type,
    thinking: block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : null,
  })
}

export function buildContextEntryViews(
  rows: readonly ContextLedgerRow[],
): ContextSnapshot['entries'] {
  const parsed = rows.map(buildContextEntryView)
  const callOwners = new Map<string, { parentEntryId: string; toolName: string }>()
  for (const entry of parsed) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue
    for (const call of entry.toolCalls) {
      callOwners.set(call.id, { parentEntryId: entry.id, toolName: call.name })
    }
  }

  const linked = parsed.map((entry): ContextSnapshot['entries'][number] => {
    if (entry.kind !== 'message' || entry.role !== 'tool' || entry.toolCallId === null) return entry
    const owner = callOwners.get(entry.toolCallId)
    return owner ? { ...entry, ...owner } : entry
  })
  const toolResultsByParent = new Map<string, Map<string, ContextSnapshot['entries'][number]>>()
  for (const entry of linked) {
    if (
      entry.kind !== 'message'
      || entry.role !== 'tool'
      || entry.parentEntryId === null
      || entry.toolCallId === null
    ) continue
    const byCall = toolResultsByParent.get(entry.parentEntryId) ?? new Map()
    if (!byCall.has(entry.toolCallId)) byCall.set(entry.toolCallId, entry)
    toolResultsByParent.set(entry.parentEntryId, byCall)
  }

  const groupedChildIds = new Set<string>()
  const groups: Array<ContextSnapshot['entries']> = []
  for (const entry of linked) {
    if (groupedChildIds.has(entry.id)) continue
    if (entry.kind === 'message' && entry.role === 'assistant') {
      const byCall = toolResultsByParent.get(entry.id)
      const children = entry.toolCalls.flatMap(call => {
        const child = byCall?.get(call.id)
        if (!child) return []
        groupedChildIds.add(child.id)
        return [child]
      })
      groups.push([entry, ...children])
      continue
    }
    if (entry.kind === 'message' && entry.role === 'tool' && entry.parentEntryId !== null) {
      continue
    }
    groups.push([entry])
  }

  groups.sort((left, right) => {
    const leftHead = left.reduce((max, entry) => max > BigInt(entry.id) ? max : BigInt(entry.id), 0n)
    const rightHead = right.reduce((max, entry) => max > BigInt(entry.id) ? max : BigInt(entry.id), 0n)
    return leftHead === rightHead ? 0 : leftHead < rightHead ? -1 : 1
  })
  return groups.flat()
}

function buildContextEntryView(row: ContextLedgerRow): ContextSnapshot['entries'][number] {
  const common = {
    id: row.id.toString(),
    entryType: row.entryType,
    createdAt: row.createdAt.toISOString(),
    rawPreview: safePreview(row.payload),
  }
  const payload = asRecord(row.payload)
  if (payload?.schemaVersion !== 1) {
    return { ...common, kind: 'unknown', role: null, parseError: '无法识别 payload schemaVersion' }
  }
  if (row.entryType === 'message') {
    const message = asRecord(payload.message)
    if (!message || !isMessageRole(message.role)) {
      return { ...common, kind: 'unknown', role: null, parseError: '无法识别 message payload' }
    }
    if (message.role === 'user') {
      if (typeof message.content !== 'string') {
        return { ...common, kind: 'unknown', role: null, parseError: '无法识别 user message' }
      }
      return messageEntry(common, 'user', previewText(message.content))
    }
    if (message.role === 'assistant') {
      if (typeof message.content !== 'string' || !Array.isArray(message.toolCalls)) {
        return { ...common, kind: 'unknown', role: null, parseError: '无法识别 assistant message' }
      }
      const toolCalls = message.toolCalls.flatMap(value => {
        const call = asRecord(value)
        return call && typeof call.id === 'string' && typeof call.name === 'string'
          ? [toolCallView(call.id, call.name, call.args)]
          : []
      })
      return {
        ...messageEntry(common, 'assistant', previewText(message.content)),
        toolCalls,
        thinkingBlocks: readThinkingBlockIndex(message.nativeBlocks),
      }
    }
    if (typeof message.toolCallId !== 'string' || !Object.hasOwn(message, 'content')) {
      return { ...common, kind: 'unknown', role: null, parseError: '无法识别 tool message' }
    }
    const result = readToolResult(message.content)
    return {
      ...messageEntry(common, 'tool', result.summary),
      toolCallId: message.toolCallId,
      result: result.details,
    }
  }
  if (row.entryType === 'compaction' && typeof payload.summary === 'string') {
    return {
      ...common,
      kind: 'compaction',
      entryType: 'compaction',
      role: null,
      summary: previewText(payload.summary),
      reason: stringOrNull(payload.reason),
      firstKeptEntryId: stringOrNull(payload.firstKeptEntryId),
      tokensBefore: nonNegativeIntegerOrNull(payload.tokensBefore),
      estimatedTokensAfter: nonNegativeIntegerOrNull(payload.estimatedTokensAfter),
      isSplitTurn: typeof payload.isSplitTurn === 'boolean' ? payload.isSplitTurn : null,
    }
  }
  return { ...common, kind: 'unknown', role: null, parseError: '无法识别 ledger entry' }
}

function messageEntry(
  common: { id: string; entryType: string; createdAt: string; rawPreview: string },
  role: 'user' | 'assistant' | 'tool',
  summary: string,
): Extract<ContextSnapshot['entries'][number], { kind: 'message' }> {
  return {
    ...common,
    kind: 'message',
    entryType: 'message',
    role,
    summary,
    toolCalls: [],
    thinkingBlocks: [],
    toolCallId: null,
    toolName: null,
    parentEntryId: null,
    result: null,
  }
}

function readThinkingBlockIndex(
  value: unknown,
): Extract<ContextSnapshot['entries'][number], { kind: 'message' }>['thinkingBlocks'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, blockIndex) => {
    const block = asRecord(item)
    if (!block || (block.type !== 'thinking' && block.type !== 'redacted_thinking')) return []
    return [{
      blockIndex,
      type: block.type,
      charCount: block.type === 'thinking' && typeof block.thinking === 'string'
        ? block.thinking.length
        : 0,
    }]
  })
}

function readToolResult(value: unknown): {
  summary: string
  details: Extract<ContextSnapshot['entries'][number], { kind: 'message' }>['result']
} {
  const record = typeof value === 'string' ? parseJsonRecord(value) : asRecord(value)
  if (!record) return { summary: previewContent(value), details: null }
  const details = {
    ok: typeof record.ok === 'boolean' ? record.ok : null,
    status: stringOrNull(record.status),
    code: stringOrNull(record.code),
    reason: stringOrNull(record.reason),
  }
  const remaining = Object.fromEntries(
    Object.entries(record).filter(([key]) => !['ok', 'status', 'code', 'reason'].includes(key)),
  )
  const summary = details.reason
    ?? stringOrNull(record.message)
    ?? stringOrNull(record.error)
    ?? (Object.keys(remaining).length === 0 ? '' : previewText(safePreview(remaining)))
  return { summary, details }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value) as unknown)
  } catch {
    return null
  }
}

function previewContent(value: unknown): string {
  return typeof value === 'string' ? previewText(value) : previewText(safePreview(value))
}

function previewText(value: string): string {
  return value.length <= CONVERSATION_TEXT_LIMIT
    ? value
    : `${value.slice(0, CONVERSATION_TEXT_LIMIT)}\n… [内容已截断]`
}

function toolCallView(id: string, name: string, value: unknown) {
  const rawArgs = asRecord(value) ?? {}
  const deferredName = name === 'invoke' ? stringOrNull(rawArgs.tool) : null
  const deferredArgs = deferredName === null ? null : asRecord(rawArgs.args)
  const args = deferredArgs ?? rawArgs
  return {
    id,
    name,
    displayName: deferredName ?? name,
    transportName: deferredName === null ? null : name,
    argsPreview: safePreview(args),
    parameters: Object.entries(args).slice(0, 5).map(([label, parameter]) => ({
      label,
      value: formatToolParameter(parameter),
    })),
  }
}

function formatToolParameter(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return singleLineLimit(value, 96)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `${value.length} 项`
  const record = asRecord(value)
  if (!record) return String(value)
  const conversation = formatConversationRef(record)
  if (conversation !== null) return conversation
  return singleLineLimit(safePreview(record), 120)
}

function formatConversationRef(value: Record<string, unknown>): string | null {
  const platform = typeof value.platform === 'string' ? value.platform.toUpperCase() : null
  const kind = value.kind === 'private' ? '私聊' : value.kind === 'group' ? '群聊' : null
  if (platform === null || kind === null) return null
  const identity = [value.externalId, value.accountId].find(item => typeof item === 'string')
  return `${platform} ${kind}${typeof identity === 'string' ? ` · ${identity}` : ''}`
}

function singleLineLimit(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isMessageRole(value: unknown): value is 'user' | 'assistant' | 'tool' {
  return value === 'user' || value === 'assistant' || value === 'tool'
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function safePreview(value: unknown): string {
  const seen = new WeakSet<object>()
  const raw = JSON.stringify(value, (key, current) => {
    if (key === 'thinking' && typeof current === 'string') return `[思考正文按需读取 ${current.length} chars]`
    if (/^(signature|data|imageData|audioData|base64)$/i.test(key) && typeof current === 'string') return `[省略 ${current.length} chars]`
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
