import { z } from 'zod'
import type { Tool } from '../tool.js'
import { prisma } from '../../database/client.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_WRITE_JOURNAL')

const argsSchema = z.object({
  kind: z.enum(['diary', 'dream']).describe('diary = 有意识的回顾; dream = 自由联想'),
  content: z
    .string()
    .min(1)
    .max(2000)
    .describe('日记或梦境的内容. ≤2000 字.'),
})

type Args = z.infer<typeof argsSchema>

export const writeJournalTool: Tool<Args> = {
  name: 'write_journal',
  description: [
    '写日记或做梦.',
    'diary = 有意识的回顾 (今天发生了什么、你的想法);',
    'dream = 自由联想 (可以混合记忆、不需要忠于事实、可以抽象和超现实).',
    'content ≤2000 字.',
    '什么时候写 / 怎么分享, 见 system prompt [日记 & 做梦] 段.',
  ].join(' '),
  schema: argsSchema,
  async execute(args) {
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
