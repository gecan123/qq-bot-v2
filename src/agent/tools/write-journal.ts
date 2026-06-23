import { z } from 'zod'
import type { Tool } from '../tool.js'
import { prisma } from '../../database/client.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_WRITE_JOURNAL')

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
  ]),
])

type Args = z.infer<typeof argsSchema>
type NormalizedArgs =
  | { action: 'write'; kind: 'diary' | 'dream'; content: string }
  | { action: 'list'; kind?: 'diary' | 'dream'; limit?: number }
  | { action: 'search'; query: string; kind?: 'diary' | 'dream'; limit?: number }

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

function renderEntries(entries: Array<{ id: number; kind: string; content: string; createdAt: Date }>) {
  return entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    createdAt: entry.createdAt.toISOString(),
    preview: preview(entry.content),
  }))
}

export const writeJournalTool: Tool<Args> = {
  name: 'write_journal',
  description: [
    '写、列出或搜索日记/梦境.',
    'action=write: 写日记或做梦;',
    'action=list: 查看最近条目;',
    'action=search: 按关键词搜索.',
    'diary = 有意识的回顾 (今天发生了什么、你的想法);',
    'dream = 自由联想 (可以混合记忆、不需要忠于事实、可以抽象和超现实).',
    '写入 content ≤2000 字; list/search 每次最多返回 20 条短 preview.',
    '空闲且没什么外界内容时可用; 这是私人内容, 不要主动往群里贴, 除非聊天自然勾上.',
  ].join(' '),
  schema: argsSchema,
  async execute(rawArgs) {
    const args = normalizeArgs(argsSchema.parse(rawArgs))
    if (args.action === 'list') {
      const entries = await prisma.journalEntry.findMany({
        where: args.kind ? { kind: args.kind } : undefined,
        orderBy: { createdAt: 'desc' },
        take: boundedLimit(args.limit),
        select: { id: true, kind: true, content: true, createdAt: true },
      })
      return { content: JSON.stringify({ ok: true, action: 'list', entries: renderEntries(entries) }) }
    }

    if (args.action === 'search') {
      const where = {
        ...(args.kind ? { kind: args.kind } : {}),
        content: { contains: args.query, mode: 'insensitive' as const },
      }
      const entries = await prisma.journalEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: boundedLimit(args.limit),
        select: { id: true, kind: true, content: true, createdAt: true },
      })
      return { content: JSON.stringify({ ok: true, action: 'search', query: args.query, entries: renderEntries(entries) }) }
    }

    const entry = await prisma.journalEntry.create({
      data: {
        kind: args.kind,
        content: args.content,
      },
      select: { id: true },
    })
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
