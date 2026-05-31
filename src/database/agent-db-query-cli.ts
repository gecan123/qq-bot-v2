import { config } from '../config/index.js'
import { executeDbRead, type SqlParamValue } from './agent-sql.js'

export interface AgentDbQueryInput {
  sql: string
  params?: Record<string, SqlParamValue>
}

function isSqlParamValue(value: unknown): value is SqlParamValue {
  return value == null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
}

function parseJsonInput(raw: string): AgentDbQueryInput {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('db query JSON input must be an object')
  }

  const obj = parsed as Record<string, unknown>
  if (typeof obj.sql !== 'string' || obj.sql.trim().length === 0) {
    throw new Error('db query JSON input must include a non-empty sql string')
  }

  let params: Record<string, SqlParamValue> | undefined
  if (obj.params !== undefined) {
    if (!obj.params || typeof obj.params !== 'object' || Array.isArray(obj.params)) {
      throw new Error('db query params must be an object')
    }
    params = {}
    for (const [key, value] of Object.entries(obj.params as Record<string, unknown>)) {
      if (!isSqlParamValue(value)) {
        throw new Error(`db query param ${key} must be string, number, boolean, or null`)
      }
      params[key] = value
    }
  }

  return { sql: obj.sql, params }
}

export function parseAgentDbQueryInput(raw: string): AgentDbQueryInput {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('db query input is required')
  if (trimmed.startsWith('{')) return parseJsonInput(trimmed)
  return { sql: trimmed, params: undefined }
}

export async function executeAgentDbQueryInput(input: AgentDbQueryInput): Promise<string> {
  const result = await executeDbRead({
    sql: input.sql,
    params: input.params,
    groupIdWhitelist: config.botTargetGroupIds,
  })
  return JSON.stringify(result, null, 2)
}
