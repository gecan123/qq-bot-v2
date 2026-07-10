import { prisma } from '../database/client.js'
import { Prisma } from '../generated/prisma/client.js'
import { createLogger } from '../logger.js'
import type { AgentMetricsFilters, AgentMetricsSummary } from './agent-metrics.js'
import { summarizeAgentMetrics } from './agent-metrics.js'
import type { AgentTokenOperation } from '../agent/token-stats.js'

const log = createLogger('AGENT_OBSERVABILITY_DB')

export interface AgentToolCallEvent {
  ts: string
  toolCallId: string
  toolName: string
  roundIndex: number
  argsSummary: unknown
  durationMs: number
  ok: boolean
  sideEffect: boolean
  error?: string
}

export interface AgentTokenUsageEvent {
  ts: string
  operation: AgentTokenOperation
  roundIndex?: number
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
  model: string
  cacheHitRate?: number
}

interface AgentObservabilityDbClient {
  $executeRaw(query: Prisma.Sql): Promise<unknown>
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
}

interface AgentToolCallRow {
  ts: Date
  toolName: string
  ok: boolean
  sideEffect: boolean
  durationMs: number
}

interface AgentTokenUsageRow {
  ts: Date
  operation: string
  model: string
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
}

export function buildInsertAgentToolCallSql(entry: AgentToolCallEvent): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "agent_tool_calls" (
      "ts",
      "tool_call_id",
      "tool_name",
      "round_index",
      "args_summary",
      "duration_ms",
      "ok",
      "side_effect",
      "error"
    )
    VALUES (
      ${new Date(entry.ts)},
      ${entry.toolCallId},
      ${entry.toolName},
      ${entry.roundIndex},
      CAST(${JSON.stringify(entry.argsSummary)} AS JSONB),
      ${entry.durationMs},
      ${entry.ok},
      ${entry.sideEffect},
      ${entry.error ?? null}
    )
  `
}

export function buildInsertAgentTokenUsageSql(entry: AgentTokenUsageEvent): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "agent_token_usage" (
      "ts",
      "operation",
      "round_index",
      "model",
      "input_tokens",
      "cached_tokens",
      "output_tokens",
      "cache_hit_rate"
    )
    VALUES (
      ${new Date(entry.ts)},
      ${entry.operation},
      ${entry.roundIndex ?? null},
      ${entry.model},
      ${entry.inputTokens},
      ${entry.cachedTokens},
      ${entry.outputTokens},
      ${entry.cacheHitRate ?? null}
    )
  `
}

export async function persistAgentToolCallEvent(
  entry: AgentToolCallEvent,
  db: AgentObservabilityDbClient = prisma,
): Promise<void> {
  await db.$executeRaw(buildInsertAgentToolCallSql(entry))
}

export async function persistAgentTokenUsageEvent(
  entry: AgentTokenUsageEvent,
  db: AgentObservabilityDbClient = prisma,
): Promise<void> {
  await db.$executeRaw(buildInsertAgentTokenUsageSql(entry))
}

export function recordAgentToolCallEvent(entry: AgentToolCallEvent): void {
  persistAgentToolCallEvent(entry).catch((err) => {
    log.warn({ err, toolName: entry.toolName, toolCallId: entry.toolCallId }, 'agent_tool_call_db_write_failed')
  })
}

export function recordAgentTokenUsageEvent(entry: AgentTokenUsageEvent): void {
  persistAgentTokenUsageEvent(entry).catch((err) => {
    log.warn({ err, operation: entry.operation, model: entry.model }, 'agent_token_usage_db_write_failed')
  })
}

export async function queryPersistedAgentMetrics(
  filters: AgentMetricsFilters = {},
  db: AgentObservabilityDbClient = prisma,
): Promise<AgentMetricsSummary> {
  const [toolRows, tokenRows] = await Promise.all([
    db.$queryRaw<AgentToolCallRow[]>(buildSelectAgentToolCallsSql(filters)),
    db.$queryRaw<AgentTokenUsageRow[]>(buildSelectAgentTokenUsageSql(filters)),
  ])

  return summarizeAgentMetrics({
    toolCallsNdjson: toolRows.map((row) => JSON.stringify({
      ts: row.ts.toISOString(),
      toolName: row.toolName,
      ok: row.ok,
      sideEffect: row.sideEffect,
      durationMs: row.durationMs,
    })).join('\n'),
    tokenUsageNdjson: tokenRows.map((row) => JSON.stringify({
      ts: row.ts.toISOString(),
      operation: row.operation,
      model: row.model,
      inputTokens: row.inputTokens,
      cachedTokens: row.cachedTokens,
      outputTokens: row.outputTokens,
    })).join('\n'),
  })
}

export function buildSelectAgentToolCallsSql(filters: AgentMetricsFilters): Prisma.Sql {
  return Prisma.sql`
    SELECT
      "ts",
      "tool_name" AS "toolName",
      "ok",
      "side_effect" AS "sideEffect",
      "duration_ms" AS "durationMs"
    FROM "agent_tool_calls"
    ${buildWhere([
      filters.from ? Prisma.sql`"ts" >= ${filters.from}` : null,
      filters.to ? Prisma.sql`"ts" <= ${filters.to}` : null,
      filters.toolName ? Prisma.sql`"tool_name" = ${filters.toolName}` : null,
      filters.ok != null ? Prisma.sql`"ok" = ${filters.ok}` : null,
      filters.sideEffect != null ? Prisma.sql`"side_effect" = ${filters.sideEffect}` : null,
    ])}
  `
}

export function buildSelectAgentTokenUsageSql(filters: AgentMetricsFilters): Prisma.Sql {
  return Prisma.sql`
    SELECT
      "ts",
      "operation",
      "model",
      "input_tokens" AS "inputTokens",
      "cached_tokens" AS "cachedTokens",
      "output_tokens" AS "outputTokens"
    FROM "agent_token_usage"
    ${buildWhere([
      filters.from ? Prisma.sql`"ts" >= ${filters.from}` : null,
      filters.to ? Prisma.sql`"ts" <= ${filters.to}` : null,
      filters.operation ? Prisma.sql`"operation" = ${filters.operation}` : null,
      filters.model ? Prisma.sql`"model" = ${filters.model}` : null,
    ])}
  `
}

function buildWhere(clauses: Array<Prisma.Sql | null>): Prisma.Sql {
  const active = clauses.filter((clause): clause is Prisma.Sql => clause != null)
  if (active.length === 0) return Prisma.empty
  return Prisma.sql`WHERE ${Prisma.join(active, ' AND ')}`
}
