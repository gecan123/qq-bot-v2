import { z } from 'zod'
import type { Tool } from '../tool.js'

const SCHEMA_PAYLOAD = {
  dialect: 'postgresql',
  constraints: {
    readOnly: true,
    autoInjectedParams: 'none — 系统不再自动注入 group_id, 想限定单源时自己传',
    namedParams: {
      group_id: '可选. 只能是 BOT_TARGET_GROUP_IDS 白名单内的群号. 不在白名单 → 工具报错',
      peer_id: '可选. 只能是 BOT_TARGET_PRIVATE_USER_IDS 白名单内的私聊 QQ. 不在白名单 → 工具报错',
    },
    maxRows: 200,
    statementTimeoutMs: 8000,
  },
  tables: [
    {
      name: 'messages',
      description:
        '群 + 私聊事实账本. group_id 仅 sceneKind=qq_group 时非空. 私聊用 scene_external_id 存对方 QQ. 跨源查询合法 (no WHERE clause needed).',
      columns: [
        'id',
        'scene_kind',          // 'qq_group' | 'qq_private'
        'scene_external_id',   // qq_group: '' (空字符串). qq_private: peerId 字符串
        'group_id',            // qq_group 必填; qq_private = NULL
        'group_name',
        'message_id',
        'sender_id',
        'sender_nickname',
        'sender_group_nickname', // 仅 qq_group 有值
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

export const dbSchemaTool: Tool<Record<string, never>> = {
  name: 'db_schema',
  description: '查看可用数据库结构(只读), 用于规划 db_read 查询. 多源后所有源都在同一张 messages 表里, 用 scene_kind 区分.',
  schema: z.object({}),
  async execute() {
    return { content: JSON.stringify(SCHEMA_PAYLOAD, null, 2) }
  },
}
