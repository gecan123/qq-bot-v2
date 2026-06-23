import { z } from 'zod'
import { resolve } from 'node:path'
import type { Tool } from '../tool.js'
import { createLogger } from '../../logger.js'
import {
  appendJournalEntry,
  listJournalEntries,
  readJournalEntry,
  searchJournalEntries,
  type JournalEntryRecord,
  type JournalKind,
} from '../journal-store.js'

const log = createLogger('TOOL_WRITE_JOURNAL')
const DEFAULT_JOURNAL_ROOT_DIR = 'data/agent-workspace'

const journalKindSchema = z.enum(['diary', 'dream'])
const legacyWriteSchema = z.object({
  kind: z.enum(['diary', 'dream']).describe('diary = 有意识的回顾; dream = 自由联想'),
  content: z
    .string()
    .min(1)
    .max(2000)
    .describe('日记或梦境的内容. ≤2000 字.'),
})

const argsSchema = z.union([
  legacyWriteSchema,
  z.discriminatedUnion('action', [
    z.object({
      action: z.literal('write').describe('写一条日记或梦境.'),
      kind: journalKindSchema.describe('diary = 有意识的回顾; dream = 自由联想'),
      content: z.string().min(1).max(2000).describe('日记或梦境的内容. ≤2000 字.'),
    }),
    z.object({
      action: z.literal('list').describe('列出最近的日记或梦境.'),
      kind: journalKindSchema.optional().describe('可选: 只看 diary 或 dream.'),
      limit: z.number().int().min(1).optional().describe('最多返回多少条, 运行时上限 20.'),
    }),
    z.object({
      action: z.literal('search').describe('按关键词搜索日记或梦境.'),
      query: z.string().min(1).max(100).describe('搜索关键词.'),
      kind: journalKindSchema.optional().describe('可选: 只搜 diary 或 dream.'),
      limit: z.number().int().min(1).optional().describe('最多返回多少条, 运行时上限 20.'),
    }),
    z.object({
      action: z.literal('read').describe('读取一条完整日记或梦境.'),
      id: z.string().min(1).describe('要读取的日记或梦境 id.'),
    }),
  ]),
])

type Args = z.infer<typeof argsSchema>
type NormalizedArgs =
  | { action: 'write'; kind: JournalKind; content: string }
  | { action: 'list'; kind?: JournalKind; limit?: number }
  | { action: 'search'; query: string; kind?: JournalKind; limit?: number }
  | { action: 'read'; id: string }

export interface WriteJournalDeps {
  journalRootDir?: string
  now?: () => Date
  id?: () => string
}

function normalizeArgs(args: Args): NormalizedArgs {
  return 'action' in args ? args : { action: 'write', ...args }
}

function boundedLimit(limit: number | undefined): number {
  if (limit == null) return 10
  return Math.min(limit, 20)
}

function preview(content: string): string {
  return content.length <= 200 ? content : `${content.slice(0, 200)}…`
}

function renderEntries(entries: JournalEntryRecord[]) {
  return entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    createdAt: entry.createdAt,
    preview: preview(entry.content),
  }))
}

export function createWriteJournalTool(deps: WriteJournalDeps = {}): Tool<Args> {
  const rootDir = resolve(deps.journalRootDir ?? DEFAULT_JOURNAL_ROOT_DIR)

  return {
    name: 'write_journal',
    description: [
      '写、列出、搜索或读取日记/梦境.',
      'action=write: 写日记或做梦;',
      'action=list: 查看最近条目;',
      'action=search: 按关键词搜索;',
      'action=read: 按 id 读取一条完整内容.',
      'diary = 有意识的回顾 (今天发生了什么、你的想法);',
      'dream = 自由联想 (可以混合记忆、不需要忠于事实、可以抽象和超现实).',
      '写入 content ≤2000 字; list/search 每次最多返回 20 条短 preview; read 只返回指定一条.',
      '内容存放在私有工作区文件中; 空闲且没什么外界内容时可用; 这是私人内容, 不要主动往群里贴, 除非聊天自然勾上.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = normalizeArgs(argsSchema.parse(rawArgs))
      if (args.action === 'list') {
        const result = await listJournalEntries({ rootDir }, { kind: args.kind, limit: boundedLimit(args.limit) })
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
        const result = await searchJournalEntries(
          { rootDir },
          { query: args.query, kind: args.kind, limit: boundedLimit(args.limit) },
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

      if (args.action === 'read') {
        const result = await readJournalEntry({ rootDir }, args.id)
        if (!result.entry) {
          return {
            content: JSON.stringify({
              ok: false,
              action: 'read',
              id: args.id,
              error: 'journal entry not found',
            }),
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
      }

      const entry = await appendJournalEntry(
        {
          rootDir,
          now: deps.now,
          id: deps.id,
        },
        {
          kind: args.kind,
          content: args.content,
        },
      )
      log.info(
        {
          journalId: entry.id,
          kind: args.kind,
          contentLength: args.content.length,
        },
        'journal_written',
      )
      return { content: JSON.stringify({ ok: true, id: entry.id, kind: args.kind }) }
    },
  }
}

export const writeJournalTool = createWriteJournalTool()
