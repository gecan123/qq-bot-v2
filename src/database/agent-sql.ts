import { prisma } from './client.js'

export type SqlParamValue = string | number | boolean | null

export interface CompiledSql {
  text: string
  values: SqlParamValue[]
}

export type SqlValidationResult =
  | { ok: true; normalizedSql: string }
  | { ok: false; reason: string }

export interface ExecuteDbReadParams {
  sql: string
  params?: Record<string, SqlParamValue>
  groupId: number
  maxRows?: number
  statementTimeoutMs?: number
  maxOutputChars?: number
}

export interface DbReadResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
  elapsedMs: number
}

const DANGEROUS_SQL_KEYWORDS = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|vacuum|analyze|refresh|merge|call|do|copy)\b/i
const GROUP_PARAM_RE = /(^|[^a-zA-Z0-9_]):group_id\b/
const GROUP_FILTER_RE = /\b(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?group_id\s*=\s*:group_id\b/i
const REPLY_AUDITS_TABLE_RE = /\breply_audits\b/i
const REPLY_AUDITS_RE = /\breply_audits\b/i

function normalizeSql(sql: string): string {
  return sql.replace(/;+\s*$/, '').trim()
}

export function validateDbReadSql(sql: string): SqlValidationResult {
  const normalizedSql = normalizeSql(sql)
  if (!normalizedSql) {
    return { ok: false, reason: 'SQL is required' }
  }

  if (normalizedSql.includes(';')) {
    return { ok: false, reason: 'Only a single statement is allowed' }
  }

  if (!/^\s*(select|with)\b/i.test(normalizedSql)) {
    return { ok: false, reason: 'Only SELECT / WITH ... SELECT statements are allowed' }
  }

  if (DANGEROUS_SQL_KEYWORDS.test(normalizedSql)) {
    return { ok: false, reason: 'SQL contains disallowed keyword for read-only execution' }
  }

  if (REPLY_AUDITS_TABLE_RE.test(normalizedSql)) {
    return { ok: false, reason: 'reply_audits is not exposed to agent SQL reads' }
  }

  if (REPLY_AUDITS_RE.test(normalizedSql)) {
    return { ok: false, reason: 'reply_audits is not available to agent db_read' }
  }

  if (!GROUP_PARAM_RE.test(normalizedSql)) {
    return { ok: false, reason: 'SQL must include :group_id parameter' }
  }

  if (!GROUP_FILTER_RE.test(normalizedSql)) {
    return { ok: false, reason: 'SQL must include an explicit group filter predicate' }
  }

  return { ok: true, normalizedSql }
}

export function compileNamedSql(sql: string, params: Record<string, SqlParamValue>): CompiledSql {
  const values: SqlParamValue[] = []
  const indexByName = new Map<string, number>()
  const hasOwn = Object.prototype.hasOwnProperty

  const text = sql.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, rawName: string) => {
    const name = rawName.trim()
    if (!hasOwn.call(params, name) || params[name] === undefined) {
      throw new Error(`Missing SQL param: ${name}`)
    }

    const existingIndex = indexByName.get(name)
    if (existingIndex !== undefined) {
      return `$${existingIndex}`
    }

    values.push(params[name]!)
    const position = values.length
    indexByName.set(name, position)
    return `$${position}`
  })

  return { text, values }
}

function serializeCell(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (Array.isArray(value)) return value.map(serializeCell)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeCell(v)] as const)
    return Object.fromEntries(entries)
  }
  return value
}

function limitRowsByOutputSize(
  columns: string[],
  rows: unknown[][],
  baseRowCount: number,
  elapsedMs: number,
  maxOutputChars: number,
): { rows: unknown[][]; truncatedByOutput: boolean } {
  if (maxOutputChars <= 0 || rows.length === 0) {
    return { rows, truncatedByOutput: false }
  }

  let trimmed = rows
  let truncatedByOutput = false
  while (trimmed.length > 0) {
    const payload = {
      columns,
      rows: trimmed,
      rowCount: baseRowCount,
      truncated: true,
      elapsedMs,
    }
    if (JSON.stringify(payload).length <= maxOutputChars) break
    trimmed = trimmed.slice(0, -1)
    truncatedByOutput = true
  }

  return { rows: trimmed, truncatedByOutput }
}

export async function executeDbRead(params: ExecuteDbReadParams): Promise<DbReadResult> {
  const validation = validateDbReadSql(params.sql)
  if (!validation.ok) {
    throw new Error(validation.reason)
  }

  const maxRows = params.maxRows ?? 200
  const timeoutMs = params.statementTimeoutMs ?? 8_000
  const maxOutputChars = params.maxOutputChars ?? 8_000
  const namedParams: Record<string, SqlParamValue> = {
    ...(params.params ?? {}),
    group_id: params.groupId,
  }

  const compiled = compileNamedSql(validation.normalizedSql, namedParams)
  const wrappedSql = `SELECT * FROM (${compiled.text}) AS _oc_agent_q LIMIT ${maxRows + 1}`

  const startedAt = Date.now()
  const rawRows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`)
    return tx.$queryRawUnsafe<Record<string, unknown>[]>(wrappedSql, ...compiled.values)
  })
  const elapsedMs = Date.now() - startedAt

  const exceededRowLimit = rawRows.length > maxRows
  const visibleRows = rawRows.slice(0, maxRows)

  const columns = visibleRows.length > 0 ? Object.keys(visibleRows[0]!) : []
  const rowArrays = visibleRows.map((row) => columns.map((col) => serializeCell(row[col])))
  const sized = limitRowsByOutputSize(columns, rowArrays, rawRows.length, elapsedMs, maxOutputChars)

  return {
    columns,
    rows: sized.rows,
    rowCount: rawRows.length,
    truncated: exceededRowLimit || sized.truncatedByOutput,
    elapsedMs,
  }
}
