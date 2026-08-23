import '@tanstack/react-start/server-only'
import { isAbsolute, join } from 'node:path'
import { formatBeijingIso } from '../../../../../src/utils/beijing-time.js'
import { readBoundedTextTail } from '../../../../../src/ops/bounded-text-tail.js'
import { getAdminPrisma } from '../../server/db.server.js'
import { getRepositoryRoot } from '../../server/paths.server.js'
import { parseOverviewToolLog } from '../overview/overview-tool-log.js'
import { metricsSnapshotSchema, type MetricsSnapshot } from './metrics.schema.js'
import { createMetricsWindow } from './metrics-window.js'

const ROW_LIMIT = 20_000
const TOOL_LOG_TAIL_MAX_BYTES = 32 * 1024 * 1024

type ToolAuditMode = MetricsSnapshot['coverage']['tools']['mode']
type CoverageStatus = MetricsSnapshot['coverage']['tools']['status']

export async function loadMetricsSnapshot(now = new Date()): Promise<MetricsSnapshot> {
  const window = createMetricsWindow(now)
  const db = getAdminPrisma()
  const [toolLog, tokens] = await Promise.all([
    readToolLog(window.from, window.to),
    db.agentTokenUsage.findMany({
      where: { ts: { gte: window.from, lte: window.to } },
      orderBy: { ts: 'desc' },
      take: ROW_LIMIT,
    }),
  ])
  const tools = toolLog.entries.slice(0, ROW_LIMIT)
  const input = sum(tokens, row => row.inputTokens ?? 0)
  const cached = sum(tokens, row => row.cachedTokens ?? 0)
  const output = sum(tokens, row => row.outputTokens ?? 0)
  const days = createDayBuckets(window.days)
  for (const row of tools) {
    const bucket = days.get(formatBeijingIso(new Date(row.ts)).slice(0, 10))
    if (bucket) {
      bucket.tools++
      if (!row.ok) bucket.failed++
    }
  }
  for (const row of tokens) {
    const bucket = days.get(formatBeijingIso(row.ts).slice(0, 10))
    if (bucket) {
      bucket.input += row.inputTokens ?? 0
      bucket.cached += row.cachedTokens ?? 0
      bucket.output += row.outputTokens ?? 0
    }
  }
  const tokenTruncated = tokens.length === ROW_LIMIT
  const toolTruncated = toolLog.truncated || toolLog.entries.length > ROW_LIMIT
  return metricsSnapshotSchema.parse({
    schemaVersion: 3,
    generatedAt: now.toISOString(),
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    coverage: {
      tools: {
        source: 'ndjson',
        status: toolLog.status,
        mode: toolLog.mode,
        truncated: toolTruncated,
        from: tools.at(-1)?.ts ?? null,
        to: tools[0]?.ts ?? null,
      },
      tokens: {
        source: 'database',
        status: 'available',
        truncated: tokenTruncated,
        from: tokens.at(-1)?.ts.toISOString() ?? null,
        to: tokens[0]?.ts.toISOString() ?? null,
      },
    },
    totals: {
      toolCalls: tools.length,
      failedTools: tools.filter(row => !row.ok).length,
      sideEffects: tools.filter(row => row.sideEffect).length,
      inputTokens: input,
      cachedTokens: cached,
      outputTokens: output,
      cacheHitRate: input > 0 ? cached / input : null,
    },
    days: [...days.values()],
    tools: groupTools(tools),
    operations: groupTokens(tokens, row => row.operation),
    models: groupTokens(tokens, row => row.model),
    warnings: [
      ...(toolLog.status === 'missing' ? ['工具审计日志不存在；工具统计当前没有可用数据。'] : []),
      ...(toolLog.status === 'invalid' ? ['工具审计日志无法读取；工具统计不可用。'] : []),
      ...(toolLog.mode === 'side_effects' ? ['工具审计为 side_effects，工具统计只覆盖副作用调用。'] : []),
      ...(toolLog.mode === 'off' ? ['工具审计已关闭，工具统计只包含已有历史日志。'] : []),
      ...(toolLog.invalidLines > 0 ? [`工具日志有 ${toolLog.invalidLines} 条无效记录，已跳过。`] : []),
      ...(toolTruncated || tokenTruncated ? ['至少一个数据源达到读取上限；页面只展示最新窗口并标记 truncated。'] : []),
    ],
  })
}

async function readToolLog(from: Date, now: Date): Promise<{
  entries: ReturnType<typeof parseOverviewToolLog>['entries']
  invalidLines: number
  mode: ToolAuditMode
  status: CoverageStatus
  truncated: boolean
}> {
  const configured = process.env.BOT_TOOL_CALL_LOG_PATH?.trim() || 'logs/tool-calls.ndjson'
  const path = isAbsolute(configured) ? configured : join(getRepositoryRoot(), configured)
  const mode = parseToolAuditMode(process.env.BOT_TOOL_AUDIT_MODE)
  try {
    const tail = await readBoundedTextTail(path, TOOL_LOG_TAIL_MAX_BYTES)
    const parsed = parseOverviewToolLog(tail.content)
    return {
      entries: parsed.entries.filter(row => row.timestampMs >= from.getTime() && row.timestampMs <= now.getTime()),
      invalidLines: parsed.invalidLines,
      mode,
      status: 'available',
      truncated: tail.truncated,
    }
  } catch (error) {
    return {
      entries: [],
      invalidLines: 0,
      mode,
      status: isNodeError(error) && error.code === 'ENOENT' ? 'missing' : 'invalid',
      truncated: false,
    }
  }
}

function parseToolAuditMode(value: string | undefined): ToolAuditMode {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'all' || normalized === 'off' ? normalized : 'side_effects'
}

function createDayBuckets(dayKeys: readonly string[]) {
  const days = new Map<string, MetricsSnapshot['days'][number]>()
  for (const day of dayKeys) {
    days.set(day, { day, tools: 0, failed: 0, input: 0, cached: 0, output: 0 })
  }
  return days
}

function sum<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0)
}

function groupTools(
  rows: Array<{ toolName: string; ok: boolean; sideEffect: boolean; durationMs: number }>,
): MetricsSnapshot['tools'] {
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const items = groups.get(row.toolName)
    if (items) items.push(row)
    else groups.set(row.toolName, [row])
  }
  return [...groups].map(([name, items]) => {
    const sorted = items.map(item => item.durationMs).sort((a, b) => a - b)
    return {
      name,
      calls: items.length,
      failed: items.filter(item => !item.ok).length,
      sideEffects: items.filter(item => item.sideEffect).length,
      avgMs: Math.round(sum(items, item => item.durationMs) / items.length),
      p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? 0,
      maxMs: sorted.at(-1) ?? 0,
    }
  }).sort((a, b) => b.calls - a.calls)
}

function groupTokens<T extends {
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
}>(rows: T[], key: (row: T) => string): MetricsSnapshot['operations'] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const name = key(row)
    const items = groups.get(name)
    if (items) items.push(row)
    else groups.set(name, [row])
  }
  return [...groups].map(([name, items]) => {
    const input = sum(items, item => item.inputTokens ?? 0)
    const cached = sum(items, item => item.cachedTokens ?? 0)
    return {
      name,
      calls: items.length,
      input,
      cached,
      output: sum(items, item => item.outputTokens ?? 0),
      cacheHitRate: input > 0 ? cached / input : null,
    }
  }).sort((a, b) => b.input - a.input)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
