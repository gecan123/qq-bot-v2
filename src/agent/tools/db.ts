import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { DbReadResult, ExecuteDbReadParams } from '../../database/agent-sql.js'

const DB_READ_MAX_ROWS = 200
const DB_READ_TIMEOUT_MS = 8_000
const DB_READ_MAX_OUTPUT_CHARS = 8_000

const SCHEMA_PAYLOAD = {
  dialect: 'postgresql',
  constraints: {
    readOnly: true,
    autoInjectedParams: 'none — 系统不再自动注入 group_id, 想限定单源时自己传',
    namedParams: {
      group_id: '可选. 只能是 BOT_TARGET_GROUP_IDS 白名单内的群号. 不在白名单 → 工具报错',
      peer_id: '可选. 私聊对方 QQ. 不走白名单, 任意 QQ 都接受',
    },
    maxRows: DB_READ_MAX_ROWS,
    statementTimeoutMs: DB_READ_TIMEOUT_MS,
  },
  tables: [
    {
      name: 'messages',
      description:
        '群 + 私聊事实账本. group_id 仅 sceneKind=qq_group 时非空. 私聊用 scene_external_id 存对方 QQ. 跨源查询合法 (no WHERE clause needed).',
      columns: [
        'id',
        'scene_kind',
        'scene_external_id',
        'group_id',
        'group_name',
        'message_id',
        'sender_id',
        'sender_nickname',
        'sender_group_nickname',
        'search_text',
        'resolved_text',
        'raw_message',
        'sent_at',
        'created_at',
      ],
      patterns: {
        '查某群最近 N 条': "WHERE scene_kind='qq_group' AND group_id=:group_id ORDER BY message_id DESC LIMIT N",
        '查某私聊最近 N 条': "WHERE scene_kind='qq_private' AND scene_external_id=:peer_id ORDER BY message_id DESC LIMIT N",
        '跨源混合查最近 N 条': 'ORDER BY created_at DESC LIMIT N (不加 WHERE 即可)',
      },
    },
    {
      name: 'media',
      description: '媒体二进制 + AI 描述缓存. 通过 message_id → message.media_reference_ids 数组关联.',
      columns: ['media_id', 'media_type', 'content_type', 'file_name', 'description_raw', 'created_at'],
    },
  ],
}

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('schema').describe('查看可用数据库结构与查询约束.'),
  }),
  z.object({
    action: z.literal('query').describe('执行只读 SQL 查询.'),
    sql: z.string().min(1).describe('只读 SQL. 想限定单源时用 :group_id / :peer_id 占位符 + 在 params 里传值.'),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe('命名参数. 如 { group_id: 111, peer_id: 10001 }. 系统不会自动注入任何 ID.'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface DbToolDeps {
  groupIdWhitelist?: readonly number[]
  executeRead?: (params: ExecuteDbReadParams) => Promise<DbReadResult | unknown>
}

export function createDbTool(deps: DbToolDeps = {}): Tool<Args> {
  const groupIdWhitelist = deps.groupIdWhitelist ?? []
  const executeRead = deps.executeRead ?? defaultExecuteRead

  return {
    name: 'db',
    description: [
      '数据库工具. action=schema 查看结构和查询约束; action=query 执行只读 SQL.',
      'query 仅允许 SELECT / WITH 查询. 系统不会自动注入 group_id.',
      '想按群过滤时在 SQL 写 :group_id 并在 params 传值; 不在监听白名单内的 group_id 会被拒绝.',
      '私聊用 scene_kind=\'qq_private\' AND scene_external_id=:peer_id; peer_id 不走群白名单.',
      '跨源查询合法, 不需要传任何 ID. 先 schema 后 query, 不要把 schema 手册背进常驻上下文.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.action === 'schema') {
        return { content: JSON.stringify(SCHEMA_PAYLOAD, null, 2) }
      }

      const result = await executeRead({
        sql: args.sql,
        params: args.params,
        groupIdWhitelist,
        maxRows: DB_READ_MAX_ROWS,
        statementTimeoutMs: DB_READ_TIMEOUT_MS,
        maxOutputChars: DB_READ_MAX_OUTPUT_CHARS,
      })
      return { content: JSON.stringify(result, null, 2) }
    },
  }
}

async function defaultExecuteRead(params: ExecuteDbReadParams): Promise<DbReadResult> {
  const { executeDbRead } = await import('../../database/agent-sql.js')
  return executeDbRead(params)
}
