import { z } from 'zod'
import type { Tool } from '../tool.js'
import { prisma } from '../../database/client.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_RECALL')

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

/** 与 remember 同形态: 不用 transform (JSON Schema 序列化限制), 字符串化在 execute 做. */
const targetSchema = z.object({
  kind: z.enum(['person', 'group']).describe('person = 某个 QQ 号; group = 某个群号'),
  id: z
    .union([z.string(), z.number()])
    .describe('QQ 号或群号. 数字或字符串都接受, 内部统一转字符串查询.'),
})

const argsSchema = z.object({
  target: targetSchema,
  keyword: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('可选: 关键词. 精确子串匹配 (大小写不敏感). 不传则按时间倒序返回最近的笔记.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`可选: 最多返回多少条 (1-${MAX_LIMIT}, 默认 ${DEFAULT_LIMIT}).`),
})

type Args = z.infer<typeof argsSchema>

interface RecallEntry {
  content: string
  when: string
}

interface RecallResult {
  entries: RecallEntry[]
  hint?: string
}

export const recallTool: Tool<Args> = {
  name: 'recall',
  description: [
    '从你的私人笔记本里翻出关于「某个人」或「某个群」的事.',
    'target 必填. keyword 可选 (精确子串, 不传按时间倒序). limit 1-20 (默认 10).',
    '返回值不含 sourceMessageIds — 那是给人工排查用的, 你不需要.',
    '什么时候翻 / 怎么用记忆说话, 见 system prompt [记忆] 段.',
  ].join(' '),
  schema: argsSchema,
  async execute(args) {
    const limit = args.limit ?? DEFAULT_LIMIT
    const targetId = String(args.target.id)
    const where: {
      targetKind: string
      targetId: string
      content?: { contains: string; mode: 'insensitive' }
    } = {
      targetKind: args.target.kind,
      targetId,
    }
    if (args.keyword) {
      where.content = { contains: args.keyword, mode: 'insensitive' }
    }

    const rows = await prisma.memoryEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { content: true, createdAt: true },
    })

    log.info(
      {
        targetKind: args.target.kind,
        targetId,
        keyword: args.keyword ?? null,
        limit,
        hitCount: rows.length,
      },
      'recall_executed',
    )

    if (rows.length === 0) {
      const result: RecallResult = {
        entries: [],
        hint: args.keyword
          ? `没有关于这个 ${args.target.kind} 的笔记包含「${args.keyword}」`
          : `没有关于这个 ${args.target.kind} 的笔记`,
      }
      return { content: JSON.stringify(result) }
    }

    const entries: RecallEntry[] = rows.map((row) => ({
      content: row.content,
      when: row.createdAt.toISOString(),
    }))
    const result: RecallResult = { entries }
    return { content: JSON.stringify(result) }
  },
}
