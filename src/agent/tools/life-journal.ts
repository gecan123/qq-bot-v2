import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { WorkspaceStateCoordinator } from '../workspace-state-coordinator.js'
import {
  appendLifeJournalEntry,
  compactLifeJournalEntries,
  deleteLifeJournalEntry,
  LifeJournalStoreError,
  readLifeAgendaSnapshot,
  readLifeJournalDay,
  readLifeJournalEntry,
  readRecentLifeJournalFiles,
  updateLifeJournalEntry,
  writeLifeAgendaIfRevision,
} from '../life-journal-store.js'

const DEFAULT_ROOT_DIR = 'data/agent-workspace'
const DEFAULT_READ_CHARS = 6000
const DEFAULT_READ_ENTRIES = 50
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('read_recent 返回的日期, 格式 YYYY-MM-DD.')
const entryIdSchema = z.string().trim().min(1).max(160).describe('read_recent 返回的 entryId.')
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/).describe('read_recent 返回的 revision; 防止覆盖更新后的文件.')

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('write').describe('主动写入一条 Life Journal 笔记.'),
    kind: z.enum(['reflection', 'dream']).optional().describe('内容类型: reflection=经历/感受, dream=梦境; 默认 reflection.'),
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
    action: z.literal('read_day').describe('分页读取一个明确日期的完整 Life Journal 日文件.'),
    date: dateSchema,
    offset: z.number().int().min(0).optional().describe('字符偏移, 默认 0.'),
    maxChars: z.number().int().min(500).max(12000).optional().describe('本页字符上限, 默认 6000.'),
  }),
  z.object({
    action: z.literal('read_entry').describe('按 entryId 完整读取一条 Life Journal 记录.'),
    date: dateSchema,
    entryId: entryIdSchema,
  }),
  z.object({
    action: z.literal('update').describe('按 entryId 修正一条 Life Journal 记录.'),
    date: dateSchema,
    entryId: entryIdSchema,
    expectedRevision: revisionSchema,
    markdown: z.string().trim().min(1).max(3000).describe('替换后的完整条目正文, 上限 3000 字符.'),
  }),
  z.object({
    action: z.literal('delete').describe('按 entryId 永久删除一条错误或重复的 Life Journal 记录.'),
    date: dateSchema,
    entryId: entryIdSchema,
    expectedRevision: revisionSchema,
  }),
  z.object({
    action: z.literal('compact').describe('把同一天至少两条 Life Journal 记录合并成一条摘要.'),
    date: dateSchema,
    entryIds: z.array(entryIdSchema).min(2).max(50).describe('要被摘要替代的 2-50 个 entryId.'),
    expectedRevision: revisionSchema,
    markdown: z.string().trim().min(1).max(12000).describe('合并后的完整摘要正文, 上限 12000 字符.'),
  }),
  z.object({
    action: z.literal('write_agenda').describe('覆盖写入完整 Life Agenda 文件.'),
    expectedRevision: revisionSchema,
    markdown: z.string().trim().min(1).max(5000).describe('完整 agenda Markdown, 上限 5000 字符.'),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface LifeJournalToolDeps {
  rootDir?: string
  now?: () => Date
  id?: () => string
  workspaceStateCoordinator?: WorkspaceStateCoordinator
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[truncated]`
}

export function createLifeJournalTool(deps: LifeJournalToolDeps = {}): Tool<Args> {
  const rootDir = deps.rootDir ?? DEFAULT_ROOT_DIR
  const storeOptions = {
    rootDir,
    now: deps.now,
    id: deps.id,
    workspaceStateCoordinator: deps.workspaceStateCoordinator,
  }

  return {
    name: 'life_journal',
    description: [
      '主动维护 Luna 的 Life Journal 和 Life Agenda.',
      '用于自己决定记录经历、感受、梦、未完兴趣、承诺和下一步; 不是普通聊天备份.',
      'action=write 写一条 reflection|dream 主观笔记; action=read_recent 回看最近笔记并取得 entryId/revision.',
      '需要完整原文时用 action=read_entry 或分页 action=read_day, 不要只依据 preview 做 compact.',
      'action=update/delete 修正或删除单条记录; action=compact 合并同一天的多条记录; 修改前必须使用最新 revision.',
      'action=read_agenda/write_agenda 读取或更新 agenda.',
      '读取结果有界; 写入应短而有选择性.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.action === 'write') {
        const entry = await appendLifeJournalEntry({
          ...storeOptions,
          kind: args.kind ?? 'reflection',
          markdown: args.markdown,
        })
        return {
          content: JSON.stringify({
            ok: true,
            action: 'write',
            path: entry.path,
            heading: entry.heading,
            entryId: entry.entryId,
            kind: args.kind ?? 'reflection',
          }),
          outcome: { ok: true },
        }
      }

      if (args.action === 'read_recent') {
        const maxChars = args.maxChars ?? DEFAULT_READ_CHARS
        let remaining = maxChars
        let remainingEntries = DEFAULT_READ_ENTRIES
        const files = await readRecentLifeJournalFiles({ ...storeOptions, days: args.days ?? 2 })
        return {
          content: JSON.stringify({
            ok: true,
            action: 'read_recent',
            files: files.map((file) => {
              const content = truncateText(file.content, remaining)
              remaining = Math.max(0, remaining - file.content.length)
              const entries = file.entries.slice(0, remainingEntries).map((entry) => ({
                entryId: entry.id,
                heading: entry.heading,
                kind: entry.kind,
                source: entry.source,
                preview: truncateText(entry.markdown, 120),
              }))
              remainingEntries = Math.max(0, remainingEntries - entries.length)
              return {
                path: file.path,
                date: file.date,
                revision: file.revision,
                content,
                entries,
                entriesTruncated: file.entries.length > entries.length,
              }
            }),
          }),
        }
      }

      if (args.action === 'read_agenda') {
        const agenda = await readLifeAgendaSnapshot(storeOptions)
        return {
          content: JSON.stringify({
            ok: true,
            action: 'read_agenda',
            markdown: truncateText(agenda.markdown, DEFAULT_READ_CHARS),
            revision: agenda.revision,
          }),
        }
      }

      if (args.action === 'read_day') {
        try {
          const file = await readLifeJournalDay({ ...storeOptions, date: args.date })
          const offset = Math.min(args.offset ?? 0, file.content.length)
          const maxChars = args.maxChars ?? DEFAULT_READ_CHARS
          const content = file.content.slice(offset, offset + maxChars)
          const nextOffset = offset + content.length
          return {
            content: JSON.stringify({
              ok: true,
              action: 'read_day',
              path: file.path,
              date: file.date,
              revision: file.revision,
              offset,
              content,
              nextOffset: nextOffset < file.content.length ? nextOffset : null,
              totalChars: file.content.length,
              truncated: nextOffset < file.content.length,
            }),
          }
        } catch (error) {
          if (error instanceof LifeJournalStoreError) {
            return {
              content: JSON.stringify({ ok: false, action: args.action, code: error.code, error: error.message }),
              outcome: { ok: false, code: error.code, error: error.message },
            }
          }
          throw error
        }
      }

      if (args.action === 'read_entry') {
        try {
          const result = await readLifeJournalEntry({ ...storeOptions, date: args.date, entryId: args.entryId })
          return {
            content: JSON.stringify({
              ok: true,
              action: 'read_entry',
              path: result.path,
              revision: result.revision,
              entry: result.entry,
            }),
          }
        } catch (error) {
          if (error instanceof LifeJournalStoreError) {
            return {
              content: JSON.stringify({ ok: false, action: args.action, code: error.code, error: error.message }),
              outcome: { ok: false, code: error.code, error: error.message },
            }
          }
          throw error
        }
      }

      try {
        if (args.action === 'update') {
          const result = await updateLifeJournalEntry({
            ...storeOptions,
            date: args.date,
            entryId: args.entryId,
            expectedRevision: args.expectedRevision,
            markdown: args.markdown,
          })
          return {
            content: JSON.stringify({
              ok: true,
              action: 'update',
              path: result.path,
              entryId: result.entry.id,
              revision: result.revision,
            }),
            outcome: { ok: true },
          }
        }

        if (args.action === 'delete') {
          const result = await deleteLifeJournalEntry({
            ...storeOptions,
            date: args.date,
            entryId: args.entryId,
            expectedRevision: args.expectedRevision,
          })
          return {
            content: JSON.stringify({ ok: true, action: 'delete', ...result }),
            outcome: { ok: true },
          }
        }

        if (args.action === 'compact') {
          const result = await compactLifeJournalEntries({
            ...storeOptions,
            date: args.date,
            entryIds: args.entryIds,
            expectedRevision: args.expectedRevision,
            markdown: args.markdown,
          })
          return {
            content: JSON.stringify({
              ok: true,
              action: 'compact',
              path: result.path,
              entryId: result.entry.id,
              compactedEntryIds: result.compactedEntryIds,
              revision: result.revision,
            }),
            outcome: { ok: true },
          }
        }
      } catch (error) {
        if (error instanceof LifeJournalStoreError) {
          return {
            content: JSON.stringify({ ok: false, action: args.action, code: error.code, error: error.message }),
            outcome: { ok: false, code: error.code, error: error.message },
          }
        }
        throw error
      }

      try {
        const agenda = await writeLifeAgendaIfRevision({
          ...storeOptions,
          expectedRevision: args.expectedRevision,
        }, args.markdown)
        return {
          content: JSON.stringify({
            ok: true,
            action: 'write_agenda',
            path: `${rootDir}/life/agenda.md`,
            revision: agenda.revision,
          }),
          outcome: { ok: true },
        }
      } catch (error) {
        if (error instanceof LifeJournalStoreError) {
          return {
            content: JSON.stringify({ ok: false, action: args.action, code: error.code, error: error.message }),
            outcome: { ok: false, code: error.code, error: error.message },
          }
        }
        throw error
      }
    },
  }
}

export const lifeJournalTool = createLifeJournalTool()
