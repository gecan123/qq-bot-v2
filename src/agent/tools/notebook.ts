import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { WorkspaceStateCoordinator } from '../workspace-state-coordinator.js'
import { CHINESE_NARRATIVE_ERROR, hasChineseNarrative } from '../long-term-language.js'
import {
  appendNotebookRecord,
  compactNotebookRecords,
  deleteNotebookRecord,
  listNotebookRecords,
  NotebookStoreError,
  readNotebookRecordSnapshot,
  searchNotebookRecords,
  updateNotebookRecord,
  type NotebookKind,
  type NotebookRecord,
} from '../notebook-store.js'

const DEFAULT_ROOT_DIR = 'data/agent-workspace'
const kindSchema = z.enum(['research', 'reading', 'market', 'project', 'general'])
  .describe('笔记类型: research=研究, reading=阅读, market=市场观察, project=项目过程, general=其他主题笔记.')
const topicSchema = z.string().trim().min(1).max(120).refine(
  (topic) => !/[\r\n]/.test(topic),
  'topic 必须是单行稳定主题',
).refine(hasChineseNarrative, CHINESE_NARRATIVE_ERROR)
  .describe('稳定的单行中文主题名；专有名词可保留原文，但要用中文说明。action=write 时必填，后续用于跨天检索和延续同一条主线.')
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/).describe('action=read 返回的 revision；action=update 或 action=delete 或 action=compact 时必填.')
const chineseNotebookContentSchema = (max: number) => z.string().trim().min(1).max(max)
  .refine(hasChineseNarrative, CHINESE_NARRATIVE_ERROR)

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('write').describe('写入一条过程笔记；必须提供 kind, topic, content.'),
    kind: kindSchema,
    topic: topicSchema,
    content: chineseNotebookContentSchema(4_000).describe('用中文叙述过程、证据、判断变化或下一步；命令、路径、URL、API 名和专有名词保留原文。上限 4000 字符.'),
  }),
  z.object({
    action: z.literal('list').describe('列出最近笔记，可按 kind/topic 过滤.'),
    kind: kindSchema.optional(),
    topic: topicSchema.optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    action: z.literal('search').describe('搜索笔记；必须提供 query.'),
    query: z.string().trim().min(1).max(200).describe('搜索关键词，上限 200 字符.'),
    kind: kindSchema.optional(),
    topic: topicSchema.optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    action: z.literal('read').describe('读取一条明确 id 的完整笔记和文件 revision.'),
    id: z.string().trim().min(1).max(160).describe('笔记 id，来自 write/list/search 结果.'),
  }),
  z.object({
    action: z.literal('update').describe('修正一条笔记；必须提供 id, expectedRevision, content.'),
    id: z.string().trim().min(1).max(160),
    expectedRevision: revisionSchema,
    topic: topicSchema.optional(),
    content: chineseNotebookContentSchema(4_000),
  }),
  z.object({
    action: z.literal('delete').describe('永久删除一条错误或重复笔记；必须提供 id, expectedRevision.'),
    id: z.string().trim().min(1).max(160),
    expectedRevision: revisionSchema,
  }),
  z.object({
    action: z.literal('compact').describe('合并同 kind、同月、同 topic 的笔记；必须提供 ids, expectedRevision, content.'),
    ids: z.array(z.string().trim().min(1).max(160)).min(2).max(50),
    expectedRevision: revisionSchema,
    content: chineseNotebookContentSchema(12_000),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface NotebookToolDeps {
  rootDir?: string
  now?: () => Date
  id?: () => string
  workspaceStateCoordinator?: WorkspaceStateCoordinator
}

function preview(content: string): string {
  return content.length <= 240 ? content : `${content.slice(0, 240)}…`
}

function renderEntries(entries: NotebookRecord[]) {
  return entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    topic: entry.topic,
    createdAt: entry.createdAt,
    preview: preview(entry.content),
  }))
}

export function createNotebookTool(deps: NotebookToolDeps = {}): Tool<Args> {
  const rootDir = deps.rootDir ?? DEFAULT_ROOT_DIR
  const storeOptions = {
    rootDir,
    now: deps.now,
    id: deps.id,
    workspaceStateCoordinator: deps.workspaceStateCoordinator,
  }
  return {
    name: 'notebook',
    description: [
      '按稳定 topic 维护研究、阅读、市场观察和项目过程笔记；不是日记，也不是稳定长期记忆.',
      'write 需要 kind、topic 和过程内容；list/search/read 用于跨天继续同一主题.',
      'update/delete/compact 前先 read 取得最新 revision；compact 只允许同 kind、同月、同 topic.',
      '已经足够稳定、以后可直接依赖的结论应另写 memory；经历、感受和梦写 life_journal.',
      'topic/content 必须以中文为叙述载体；命令、路径、URL、API 名和专有名词可保留原文，但要用中文说明.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        if (args.action === 'write') {
          const entry = await appendNotebookRecord(
            storeOptions,
            { kind: args.kind as NotebookKind, topic: args.topic, content: args.content },
          )
          return {
            content: JSON.stringify({ ok: true, action: 'write', entry }),
            outcome: {
              ok: true,
              code: 'written',
              progress: true,
              shareCandidate: {
                key: `notebook:${entry.id}`,
                cooldownKey: `notebook:${entry.kind}:${entry.topic}`,
                summary: `Notebook 主题“${entry.topic}”新增了一项${entry.kind}成果。`,
              },
            },
          }
        }
        if (args.action === 'list') {
          const result = await listNotebookRecords(
            storeOptions,
            { kind: args.kind as NotebookKind | undefined, topic: args.topic, limit: args.limit ?? 10 },
          )
          return { content: JSON.stringify({ ok: true, action: 'list', ...result, entries: renderEntries(result.entries) }) }
        }
        if (args.action === 'search') {
          const result = await searchNotebookRecords(
            storeOptions,
            {
              query: args.query,
              kind: args.kind as NotebookKind | undefined,
              topic: args.topic,
              limit: args.limit ?? 10,
            },
          )
          return { content: JSON.stringify({ ok: true, action: 'search', ...result, entries: renderEntries(result.entries) }) }
        }
        if (args.action === 'read') {
          const result = await readNotebookRecordSnapshot(storeOptions, args.id)
          if (!result) {
            return {
              content: JSON.stringify({ ok: false, action: 'read', code: 'not_found', error: 'notebook entry not found' }),
              outcome: { ok: false, code: 'not_found' },
            }
          }
          return { content: JSON.stringify({ ok: true, action: 'read', ...result }) }
        }
        if (args.action === 'update') {
          const result = await updateNotebookRecord({
            ...storeOptions,
            entryId: args.id,
            expectedRevision: args.expectedRevision,
            topic: args.topic,
            content: args.content,
          })
          return {
            content: JSON.stringify({ ok: true, action: 'update', ...result }),
            outcome: {
              ok: true,
              code: 'updated',
              progress: true,
              shareCandidate: {
                key: `notebook:${result.entry.id}:${result.revision}`,
                cooldownKey: `notebook:${result.entry.kind}:${result.entry.topic}`,
                summary: `Notebook 主题“${result.entry.topic}”形成了新的阶段性成果。`,
              },
            },
          }
        }
        if (args.action === 'delete') {
          const result = await deleteNotebookRecord({
            ...storeOptions,
            entryId: args.id,
            expectedRevision: args.expectedRevision,
          })
          return {
            content: JSON.stringify({ ok: true, action: 'delete', ...result }),
            outcome: { ok: true, code: 'deleted', progress: true },
          }
        }
        const result = await compactNotebookRecords({
          ...storeOptions,
          ids: args.ids,
          expectedRevision: args.expectedRevision,
          content: args.content,
        })
        return {
          content: JSON.stringify({ ok: true, action: 'compact', ...result }),
          outcome: {
            ok: true,
            code: 'compacted',
            progress: true,
            shareCandidate: {
              key: `notebook:${result.entry.id}:${result.revision}`,
              cooldownKey: `notebook:${result.entry.kind}:${result.entry.topic}`,
              summary: `Notebook 主题“${result.entry.topic}”完成了一次阶段整理。`,
            },
          },
        }
      } catch (error) {
        if (error instanceof NotebookStoreError) {
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

export const notebookTool = createNotebookTool()
