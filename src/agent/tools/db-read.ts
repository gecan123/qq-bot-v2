import { z } from 'zod'
import type { Tool } from '../tool.js'
import { executeDbRead, type SqlParamValue } from '../../database/agent-sql.js'
import { config } from '../../config/index.js'

const DB_READ_MAX_ROWS = 200
const DB_READ_TIMEOUT_MS = 8_000
const DB_READ_MAX_OUTPUT_CHARS = 8_000

export const dbReadTool: Tool<{ sql: string; params?: Record<string, SqlParamValue> }> = {
  name: 'db_read',
  description: [
    '执行只读 SQL 查询。仅允许 SELECT / WITH 查询。',
    '多源后系统不再自动注入 group_id —— 你想按某个群过滤时, 在 SQL 里写 :group_id (或 :peer_id) 占位符,',
    '并在 params 里显式传值. 不在白名单 (BOT_TARGET_GROUP_IDS / BOT_TARGET_PRIVATE_USER_IDS) 内的 ID 会被工具拒绝.',
    '跨源查询 (例如「最近 50 条所有源消息」) 是合法的, 不需要传任何 ID. 这是单上下文 bot 的天然能力.',
    '查群消息典型: WHERE scene_kind=\'qq_group\' AND group_id = :group_id',
    '查私聊典型:   WHERE scene_kind=\'qq_private\' AND scene_external_id = :peer_id',
  ].join(' '),
  schema: z.object({
    sql: z.string().min(1).describe('只读 SQL. 想限定单源时用 :group_id / :peer_id 占位符 + 在 params 里传值.'),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe('命名参数. 如 { group_id: 111, peer_id: 10001 }. 系统不会自动注入任何 ID.'),
  }),
  async execute(args) {
    const result = await executeDbRead({
      sql: args.sql,
      params: args.params,
      groupIdWhitelist: config.botTargetGroupIds,
      peerIdWhitelist: config.botTargetPrivateUserIds,
      maxRows: DB_READ_MAX_ROWS,
      statementTimeoutMs: DB_READ_TIMEOUT_MS,
      maxOutputChars: DB_READ_MAX_OUTPUT_CHARS,
    })
    return { content: JSON.stringify(result, null, 2) }
  },
}
