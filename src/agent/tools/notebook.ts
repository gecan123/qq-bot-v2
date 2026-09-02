import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { WorkspaceStateCoordinator } from '../workspace-state-coordinator.js'
import { CHINESE_NARRATIVE_ERROR, hasChineseNarrative } from '../long-term-language.js'
import {
  checkpointNotebookRecord,
  listNotebookRecords,
  NotebookStoreError,
  readNotebookRecordSnapshot,
  searchNotebookRecords,
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
  .describe('稳定的单行中文主题名；checkpoint 时作为更新键。general 最多 5 个，先 list 并复用原 topic，禁止用近义词新建.')
const chineseNotebookContentSchema = (max: number) => z.string().trim().min(1).max(max)
  .refine(hasChineseNarrative, CHINESE_NARRATIVE_ERROR)

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('checkpoint').describe('保存一个 topic 的完整当前状态；必须提供 kind, topic, content。同 topic 已存在时自动替换并收敛重复记录，不追加过程日志.'),
    kind: kindSchema,
    topic: topicSchema,
    content: chineseNotebookContentSchema(4_000).describe('该 topic 可独立恢复的完整当前状态，包括有效证据、当前判断和明确下一步；不要只写本轮新增日志。上限 4000 字符.'),
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
    action: z.literal('read').describe('读取 list/search 返回的一个当前 topic 完整状态.'),
    id: z.string().trim().min(1).max(160).describe('笔记 id，来自 list/search 结果.'),
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
    updatedAt: entry.updatedAt,
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
      '按稳定 topic 维护研究、阅读、市场观察和项目的当前状态；不是日记，也不保存逐轮运行记录.',
      'checkpoint 需要 kind、topic 和可独立恢复的完整当前状态；同 topic 自动更新并清理重复记录，不追加新日志.',
      'list/search/read 用于跨天恢复当前状态；文件、revision、去重和整理都由 Notebook 模块内部管理.',
      '已经足够稳定、以后可直接依赖的结论应另写 memory；未来时点重新评估用 schedule.',
      'topic/content 必须以中文为叙述载体；命令、路径、URL、API 名和专有名词可保留原文，但要用中文说明.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        if (args.action === 'checkpoint') {
          const result = await checkpointNotebookRecord(
            storeOptions,
            { kind: args.kind as NotebookKind, topic: args.topic, content: args.content },
          )
          return {
            content: JSON.stringify({
              ok: true,
              action: 'checkpoint',
              changed: result.changed,
              created: result.created,
              id: result.entry.id,
              kind: result.entry.kind,
              topic: result.entry.topic,
              createdAt: result.entry.createdAt,
              updatedAt: result.entry.updatedAt,
              consolidatedCount: result.consolidatedIds.length,
            }),
            outcome: {
              ok: true,
              code: result.created ? 'created' : result.changed ? 'updated' : 'unchanged',
              progress: false,
            },
          }
        }
        if (args.action === 'list') {
          const result = await listNotebookRecords(
            storeOptions,
            { kind: args.kind as NotebookKind | undefined, topic: args.topic, limit: args.limit ?? 10 },
          )
          return {
            content: JSON.stringify({ ok: true, action: 'list', ...result, entries: renderEntries(result.entries) }),
            outcome: { ok: true, code: result.entries.length > 0 ? 'observed' : 'empty', progress: false },
          }
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
          return {
            content: JSON.stringify({ ok: true, action: 'search', ...result, entries: renderEntries(result.entries) }),
            outcome: { ok: true, code: result.entries.length > 0 ? 'observed' : 'empty', progress: false },
          }
        }
        if (args.action === 'read') {
          const result = await readNotebookRecordSnapshot(storeOptions, args.id)
          if (!result) {
            return {
              content: JSON.stringify({ ok: false, action: 'read', code: 'not_found', error: 'notebook entry not found' }),
              outcome: { ok: false, code: 'not_found' },
            }
          }
          return {
            content: JSON.stringify({ ok: true, action: 'read', entry: result.entry }),
            outcome: { ok: true, code: 'observed', progress: false },
          }
        }

        throw new Error('unsupported notebook action')
      } catch (error) {
        if (error instanceof NotebookStoreError) {
          return {
            content: JSON.stringify({ ok: false, action: args.action, code: error.code, error: error.message }),
            outcome: {
              ok: false,
              code: error.code,
              error: error.message,
              progress: false,
              ...(error.code === 'topic_limit_reached'
                ? { continuation: 'wait_attention' as const }
                : {}),
            },
          }
        }
        throw error
      }
    },
  }
}

export const notebookTool = createNotebookTool()
