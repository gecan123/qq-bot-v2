import { z } from 'zod'
import type { Tool } from '../tool.js'
import {
  appendLifeJournalEntry,
  readLifeAgenda,
  readRecentLifeJournalFiles,
  writeLifeAgenda,
} from '../life-journal-store.js'

const DEFAULT_ROOT_DIR = 'data/agent-workspace'
const DEFAULT_READ_CHARS = 6000

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('write').describe('主动写入一条 Life Journal 笔记.'),
    markdown: z.string().trim().min(1).max(3000).describe('Markdown 内容, 上限 3000 字符.'),
  }),
  z.object({
    action: z.literal('read_recent').describe('读取最近的 Life Journal 日文件.'),
    days: z.number().int().min(1).max(7).optional().describe('读取最近天数, 默认 2, 上限 7.'),
    maxChars: z.number().int().min(500).max(12000).optional().describe('总输出字符上限, 默认 6000.'),
  }),
  z.object({
    action: z.literal('read_agenda').describe('读取当前 Life Agenda.'),
  }),
  z.object({
    action: z.literal('write_agenda').describe('覆盖写入完整 Life Agenda 文件.'),
    markdown: z.string().trim().min(1).max(5000).describe('完整 agenda Markdown, 上限 5000 字符.'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface LifeJournalToolDeps {
  rootDir?: string
  now?: () => Date
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[truncated]`
}

export function createLifeJournalTool(deps: LifeJournalToolDeps = {}): Tool<Args> {
  const rootDir = deps.rootDir ?? DEFAULT_ROOT_DIR

  return {
    name: 'life_journal',
    description: [
      '主动维护 Luna 的 Life Journal 和 Life Agenda.',
      '用于自己决定记录经历、感受、未完兴趣、承诺和下一步; 不是普通聊天备份.',
      'action=write 写一条主观笔记; action=read_recent 回看最近笔记; action=read_agenda/write_agenda 读取或更新 agenda.',
      '读取结果有界; 写入应短而有选择性.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.action === 'write') {
        const entry = await appendLifeJournalEntry({
          rootDir,
          now: deps.now,
          markdown: args.markdown,
        })
        return {
          content: JSON.stringify({ ok: true, action: 'write', path: entry.path, heading: entry.heading }),
          outcome: { ok: true },
        }
      }

      if (args.action === 'read_recent') {
        const maxChars = args.maxChars ?? DEFAULT_READ_CHARS
        let remaining = maxChars
        const files = await readRecentLifeJournalFiles({ rootDir, now: deps.now, days: args.days ?? 2 })
        return {
          content: JSON.stringify({
            ok: true,
            action: 'read_recent',
            files: files.map((file) => {
              const content = truncateText(file.content, remaining)
              remaining = Math.max(0, remaining - file.content.length)
              return { path: file.path, content }
            }),
          }),
        }
      }

      if (args.action === 'read_agenda') {
        return {
          content: JSON.stringify({
            ok: true,
            action: 'read_agenda',
            markdown: truncateText(await readLifeAgenda({ rootDir, now: deps.now }), DEFAULT_READ_CHARS),
          }),
        }
      }

      await writeLifeAgenda({ rootDir, now: deps.now }, args.markdown)
      return {
        content: JSON.stringify({ ok: true, action: 'write_agenda', path: `${rootDir}/life/agenda.md` }),
        outcome: { ok: true },
      }
    },
  }
}

export const lifeJournalTool = createLifeJournalTool()
