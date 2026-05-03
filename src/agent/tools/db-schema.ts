import { z } from 'zod'
import type { Tool } from '../tool.js'

const SCHEMA_PAYLOAD = {
  dialect: 'postgresql',
  constraints: {
    readOnly: true,
    requiredParam: ':group_id',
    requiredPredicateForms: ['group_id = :group_id', '<alias>.group_id = :group_id'],
    maxRows: 200,
    statementTimeoutMs: 8000,
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
  ],
}

export const dbSchemaTool: Tool<Record<string, never>> = {
  name: 'db_schema',
  description: '查看可用数据库结构(只读), 用于规划 db_read 查询。',
  schema: z.object({}),
  async execute() {
    return { content: JSON.stringify(SCHEMA_PAYLOAD, null, 2) }
  },
}
