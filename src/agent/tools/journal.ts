import { z } from 'zod'
import type { Tool } from '../tool.js'
import {
  appendJournalRecord,
  listJournalRecords,
  readJournalRecord,
  searchJournalRecords,
  type JournalKind,
  type JournalRecord,
} from '../journal-store.js'

const DEFAULT_ROOT_DIR = 'data/agent-workspace'

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('write').describe('写入一条日记或梦境.'),
    kind: z.enum(['diary', 'dream']).describe('记录类型: diary=日记, dream=梦境.'),
    content: z.string().trim().min(1).max(2000).describe('记录内容, 上限 2000 字符.'),
  }),
  z.object({
    action: z.literal('list').describe('列出最近日记/梦境记录.'),
    kind: z.enum(['diary', 'dream']).optional().describe('可选记录类型过滤.'),
    limit: z.number().int().min(1).max(20).optional().describe('返回条数, 默认 10, 上限 20.'),
  }),
  z.object({
    action: z.literal('search').describe('搜索日记/梦境记录.'),
    query: z.string().trim().min(1).max(100).describe('搜索关键词, 上限 100 字符.'),
    kind: z.enum(['diary', 'dream']).optional().describe('可选记录类型过滤.'),
    limit: z.number().int().min(1).max(20).optional().describe('返回条数, 默认 10, 上限 20.'),
  }),
  z.object({
    action: z.literal('read').describe('读取一条明确 id 的日记/梦境记录.'),
    id: z.string().trim().min(1).max(120).describe('记录 id, 来自 list/search/write 结果.'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface JournalToolDeps {
  rootDir?: string
  now?: () => Date
  id?: () => string
}

function boundedLimit(limit: number | undefined): number {
  return limit == null ? 10 : Math.min(limit, 20)
}

function preview(content: string): string {
  return content.length <= 200 ? content : `${content.slice(0, 200)}…`
}

function renderEntries(entries: JournalRecord[]) {
  return entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    createdAt: entry.createdAt,
    preview: preview(entry.content),
  }))
}

export function createJournalTool(deps: JournalToolDeps = {}): Tool<Args> {
  const rootDir = deps.rootDir ?? DEFAULT_ROOT_DIR

  return {
    name: 'journal',
    description: [
      '写入和回顾 Luna 私有工作区里的日记/梦境.',
      'action=write 写入 diary|dream; action=list/search/read 回看记录.',
      '这是长期私有记录, 只写自己以后仍可能回看的日记或梦境; 不要存敏感信息、一次性闲聊或群聊备份.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.action === 'write') {
        const entry = await appendJournalRecord(
          { rootDir, now: deps.now, id: deps.id },
          { kind: args.kind, content: args.content },
        )
        return {
          content: JSON.stringify({ ok: true, id: entry.id, kind: entry.kind, createdAt: entry.createdAt }),
          outcome: { ok: true },
        }
      }

      if (args.action === 'list') {
        const result = await listJournalRecords(
          { rootDir },
          { kind: args.kind as JournalKind | undefined, limit: boundedLimit(args.limit) },
        )
        return {
          content: JSON.stringify({
            ok: true,
            action: 'list',
            entries: renderEntries(result.entries),
            skippedCorrupt: result.skippedCorrupt,
          }),
        }
      }

      if (args.action === 'search') {
        const result = await searchJournalRecords(
          { rootDir },
          { query: args.query, kind: args.kind as JournalKind | undefined, limit: boundedLimit(args.limit) },
        )
        return {
          content: JSON.stringify({
            ok: true,
            action: 'search',
            query: args.query,
            entries: renderEntries(result.entries),
            skippedCorrupt: result.skippedCorrupt,
          }),
        }
      }

      const result = await readJournalRecord({ rootDir }, args.id)
      if (!result.entry) {
        return {
          content: JSON.stringify({
            ok: false,
            action: 'read',
            id: args.id,
            error: 'journal entry not found',
            skippedCorrupt: result.skippedCorrupt,
          }),
          outcome: { ok: false, code: 'not_found' },
        }
      }

      return {
        content: JSON.stringify({
          ok: true,
          action: 'read',
          entry: result.entry,
          skippedCorrupt: result.skippedCorrupt,
        }),
      }
    },
  }
}

export const journalTool = createJournalTool()
