import { z } from 'zod'
import type { Tool } from '../tool.js'
import { executeDbRead, type SqlParamValue } from '../../database/agent-sql.js'
import { config } from '../../config/index.js'

const DB_READ_MAX_ROWS = 200
const DB_READ_TIMEOUT_MS = 8_000
const DB_READ_MAX_OUTPUT_CHARS = 8_000

export const dbReadTool: Tool<{ sql: string; params?: Record<string, SqlParamValue> }> = {
  name: 'db_read',
  description:
    '执行只读 SQL 查询。仅允许 SELECT / WITH 查询, 必须包含 :group_id 参数并带显式 group_id 过滤条件。group_id 由系统自动注入,你不要也不能传它。',
  schema: z.object({
    sql: z.string().min(1).describe('只读 SQL, 必须包含 :group_id'),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe('可选命名参数; group_id 会由系统注入'),
  }),
  async execute(args) {
    const result = await executeDbRead({
      sql: args.sql,
      params: args.params,
      groupId: config.botTargetGroupIds[0] ?? 0,
      maxRows: DB_READ_MAX_ROWS,
      statementTimeoutMs: DB_READ_TIMEOUT_MS,
      maxOutputChars: DB_READ_MAX_OUTPUT_CHARS,
    })
    return { content: JSON.stringify(result, null, 2) }
  },
}
