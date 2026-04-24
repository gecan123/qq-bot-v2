import { z } from 'zod'
import { tavily } from '@tavily/core'
import type { AgentToolDeclaration } from './types.js'
import { config } from '../config/index.js'
import { executeDbRead, type SqlParamValue } from '../database/agent-sql.js'

export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>

const DB_READ_MAX_ROWS = 200
const DB_READ_TIMEOUT_MS = 8_000
const DB_READ_MAX_OUTPUT_CHARS = 8_000
const WEB_SEARCH_MAX_RESULTS = 5
const WEB_SEARCH_MAX_OUTPUT_CHARS = 2_000

const dbSchemaDecl: AgentToolDeclaration = {
  name: 'db_schema',
  description: '查看可用数据库结构（只读），用于规划 db_read 查询',
  inputSchema: z.object({}),
}

const dbReadDecl: AgentToolDeclaration = {
  name: 'db_read',
  description:
    '执行只读 SQL 查询。仅允许 SELECT / WITH 查询，必须包含 :group_id 参数并带显式 group_id 过滤条件。',
  inputSchema: z.object({
    sql: z.string().min(1).describe('只读 SQL，必须包含 :group_id'),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe('可选命名参数；group_id 会由系统注入'),
  }),
}

const finalAnswerDecl: AgentToolDeclaration = {
  name: 'final_answer',
  description: '当你准备好最终回复时调用。调用后循环立即终止。',
  inputSchema: z.object({
    replyText: z.string().min(1).describe('最终发给群里的回复正文，不超过500字'),
    confidence: z.enum(['high', 'medium', 'low']).describe('你对这条回复是否站得住脚的主观置信度'),
    shouldReferenceContext: z.boolean().describe('这条回复是否显式依赖了群聊上下文、数据库结果或搜索结果'),
    shouldAskClarifyingQuestion: z.boolean().describe('如果信息不足，是否应该先澄清再继续'),
    contextCitations: z.array(z.string()).max(3).optional().describe('可选；列出你实际依赖的上下文要点，简短即可'),
  }),
}

const webSearchDecl: AgentToolDeclaration = {
  name: 'web_search',
  description: '搜索互联网获取实时信息。当群聊历史中找不到答案时使用。',
  inputSchema: z.object({
    query: z.string().min(1).describe('搜索查询词'),
    maxResults: z.number().int().min(1).max(10).optional().describe('结果条数，默认5，最大10'),
  }),
}

export interface AgentTools {
  declarations: AgentToolDeclaration[]
  executors: Record<string, ToolExecutor>
}

function buildDbSchemaPayload() {
  return {
    dialect: 'postgresql',
    constraints: {
      readOnly: true,
      requiredParam: ':group_id',
      requiredPredicateForms: ['group_id = :group_id', '<alias>.group_id = :group_id'],
      maxRows: DB_READ_MAX_ROWS,
      statementTimeoutMs: DB_READ_TIMEOUT_MS,
    },
    tables: [
      {
        name: 'messages',
        columns: [
          'group_id',
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
      },
      {
        name: 'media',
        columns: ['media_id', 'media_type', 'content_type', 'file_name', 'description_raw', 'created_at'],
      },
      {
        name: 'conversation_states',
        columns: ['group_id', 'sender_thread_key', 'compacted_base', 'compacted_version', 'last_compacted_message_row_id', 'updated_at'],
      },
      {
        name: 'assistant_turns',
        columns: ['group_id', 'sender_thread_key', 'reply_intent_id', 'trigger_message_row_id', 'incorporated_message_row_id', 'sequence', 'reply_to_message_id', 'mention_user_id', 'status', 'attempt_count', 'created_at', 'updated_at'],
      },
      {
        name: 'reply_records',
        columns: [
          'runtime_key',
          'group_id',
          'scope_key',
          'reply_intent_id',
          'source_kind',
          'trigger_message_row_id',
          'incorporated_message_row_id',
          'delivery_payload',
          'text',
          'execution_state',
          'provider_message_id',
          'attempt_count',
          'created_at',
          'updated_at',
        ],
      },
    ],
  }
}

function toSqlParams(value: Record<string, unknown> | undefined): Record<string, SqlParamValue> | undefined {
  if (!value) return undefined
  const out: Record<string, SqlParamValue> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v
      continue
    }
    throw new Error(`Unsupported SQL param type for key: ${k}`)
  }
  return out
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function formatWebSearchResults(
  results: Array<{ title: string; url: string; content: string }>,
): string {
  const payload = {
    results: results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    })),
  }
  return truncate(JSON.stringify(payload, null, 2), WEB_SEARCH_MAX_OUTPUT_CHARS)
}

export function createAgentTools(groupId: number): AgentTools {
  const declarations: AgentToolDeclaration[] = [dbSchemaDecl, dbReadDecl, finalAnswerDecl]
  if (config.tavily?.apiKey) declarations.push(webSearchDecl)

  const executors: Record<string, ToolExecutor> = {
    db_schema: async () => JSON.stringify(buildDbSchemaPayload(), null, 2),

    db_read: async (args) => {
      const parsed = dbReadDecl.inputSchema.parse(args) as {
        sql: string
        params?: Record<string, unknown>
      }
      const result = await executeDbRead({
        sql: parsed.sql,
        params: toSqlParams(parsed.params),
        groupId,
        maxRows: DB_READ_MAX_ROWS,
        statementTimeoutMs: DB_READ_TIMEOUT_MS,
        maxOutputChars: DB_READ_MAX_OUTPUT_CHARS,
      })
      return JSON.stringify(result, null, 2)
    },

    web_search: async (args) => {
      const parsed = webSearchDecl.inputSchema.parse(args) as { query: string; maxResults?: number }
      const apiKey = config.tavily?.apiKey
      if (!apiKey) {
        return JSON.stringify({ error: 'web_search 工具未配置 API key' })
      }

      try {
        const client = tavily({ apiKey })
        const response = await client.search(parsed.query, {
          maxResults: Math.min(parsed.maxResults ?? WEB_SEARCH_MAX_RESULTS, 10),
        })
        return formatWebSearchResults(response.results)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return JSON.stringify({ error: `搜索失败: ${message}` })
      }
    },
  }

  return { declarations, executors }
}
