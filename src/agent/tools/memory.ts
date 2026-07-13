import { z } from 'zod'
import type { Tool } from '../tool.js'
import {
  compactMemoryEntries,
  deleteMemoryEntry,
  deleteMemoryFiles,
  listMemoryFiles,
  markMemoryEntryDisputed,
  readMemoryFile,
  searchMemoryEntries,
  supersedeMemoryEntry,
  recallMemoryEntries,
  proposeMemoryReview,
  promoteMemoryEntry,
  writeMemoryEntry,
  updateMemoryEntry,
  MemoryStoreError,
  type MemoryScope,
} from '../memory-store.js'
import { createLogger } from '../../logger.js'
import type { MemoryMaintenanceRuntime } from '../memory-maintenance.js'
import type { WorkspaceStateCoordinator } from '../workspace-state-coordinator.js'

const log = createLogger('TOOL_MEMORY')

const DEFAULT_WORKSPACE_DIR = 'data/agent-workspace'

const scopeSchema = z.enum(['self', 'person', 'group', 'topic'])
const idSchema = z.union([z.string(), z.number()])
const memoryFileSchema = z.string().trim().min(1).max(200).refine(
  (file) => file.endsWith('.md')
    && !file.startsWith('/')
    && !file.includes('\\')
    && !file.split('/').includes('..'),
  '必须是 memory 内的 .md 相对路径',
).describe('memory 内的 .md 相对路径, 必须来自 memory list/search/read 结果; 不允许绝对路径、反斜杠或 .. 路径段.')

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('write').describe('写入一条长期记忆.'),
    scope: scopeSchema.describe('记忆范围: self=自己做事/经验, person=某个 QQ 用户, group=某个群, topic=某个主题.'),
    id: idSchema.optional().describe('person/group 需要: QQ 号或群号. topic/self 通常不需要.'),
    title: z.string().trim().min(1).max(80).optional().describe('topic 必填稳定主题标题; self 可选. 不要用“今日速记”这类日期流水账标题.'),
    content: z.string().trim().min(1).max(500).describe('要记下来的内容. ≤500 字, 用自己的话写, 一条记一件事.'),
    sourceMessageIds: z.array(z.number().int()).optional().describe('可选: 来源 Message.id 列表, 仅供人工排查.'),
  }),
  z.object({
    action: z.literal('search').describe('搜索长期记忆.'),
    scope: scopeSchema.optional().describe('可选: 限定搜索范围.'),
    keyword: z.string().trim().min(1).max(100).optional().describe('可选: 关键词. 不传则按更新时间返回最近文件摘要.'),
    limit: z.number().int().min(1).max(20).optional().describe('可选: 最多返回多少条 (1-20, 默认 10).'),
  }),
  z.object({
    action: z.literal('recall').describe('按相关性召回 entry 级长期记忆并返回可解释分数.'),
    query: z.string().trim().min(1).max(300),
    scope: scopeSchema.optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    action: z.literal('review').describe('只读扫描重复、近重复和可能冲突，返回整理 proposal，不自动改写.'),
    scope: scopeSchema.optional(),
    file: memoryFileSchema.optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    action: z.literal('read').describe('读取某个记忆文件.'),
    file: memoryFileSchema,
    offset: z.number().int().min(0).optional().describe('字符偏移, 默认 0.'),
    maxChars: z.number().int().min(500).max(12000).optional().describe('本页字符上限, 默认 4000.'),
  }),
  z.object({
    action: z.literal('list').describe('列出记忆文件元数据, 不返回正文.'),
    scope: scopeSchema.optional().describe('可选: 限定记忆范围.'),
    limit: z.number().int().min(1).max(100).optional().describe('最多返回多少个文件 (1-100, 默认 50).'),
  }),
  z.object({
    action: z.literal('delete').describe('永久删除明确指定的记忆文件.'),
    files: z.array(memoryFileSchema).min(1).max(50).describe('要永久删除的 1-50 个 memory 相对路径.'),
  }),
  z.object({
    action: z.literal('update_entry').describe('按 entryId 修正记忆文件中的一条记录.'),
    file: memoryFileSchema,
    entryId: z.string().trim().min(1).max(160),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string().trim().min(1).max(500),
  }),
  z.object({
    action: z.literal('delete_entry').describe('按 entryId 永久删除记忆文件中的一条记录.'),
    file: memoryFileSchema,
    entryId: z.string().trim().min(1).max(160),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    action: z.literal('promote_entry').describe('把一条 recent 线索提升为 stable 长期记忆，可同时精炼措辞.'),
    file: memoryFileSchema,
    entryId: z.string().trim().min(1).max(160),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string().trim().min(1).max(1000).optional(),
  }),
  z.object({
    action: z.literal('mark_disputed').describe('把一条需要核实或存在冲突的记忆标为 disputed.'),
    file: memoryFileSchema,
    entryId: z.string().trim().min(1).max(160),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    action: z.literal('supersede_entry').describe('用同一文件内的新条目明确替代旧条目，并保留可追溯关系.'),
    file: memoryFileSchema,
    entryId: z.string().trim().min(1).max(160).describe('被替代的旧 entryId.'),
    replacementEntryId: z.string().trim().min(1).max(160)
      .describe('action=supersede_entry 时必填: 用来替代旧事实的新 entryId，必须来自同一文件.'),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    action: z.literal('compact').describe('把同一记忆文件中的至少两条记录合并成一条稳定摘要.'),
    file: memoryFileSchema,
    entryIds: z.array(z.string().trim().min(1).max(160)).min(2).max(50),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string().trim().min(1).max(2000),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface MemoryToolDeps {
  workspaceDir?: string
  now?: () => Date
  id?: () => string
  maintenance?: MemoryMaintenanceRuntime
  workspaceStateCoordinator?: WorkspaceStateCoordinator
}

export function createMemoryTool(deps: MemoryToolDeps = {}): Tool<Args> {
  const workspaceDir = deps.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const storeOptions = {
    rootDir: workspaceDir,
    now: deps.now,
    id: deps.id,
    workspaceStateCoordinator: deps.workspaceStateCoordinator,
  }

  return {
    name: 'memory',
    description: [
      '本地 Markdown 长期记忆库, 一个入口用 action 决定动作.',
      'action=write: 写入以后可能用得上的真实信息或经验; 写前先 recall，已有事实优先 update_entry/compact，避免重复追加.',
      'action=search: 搜索自己、人物、群或主题记忆; 不确定旧事、偏好、项目线索或自己做过什么时先查.',
      'action=recall: 用自然查询召回 entry 级相关记忆，返回 matchedTerms 和可解释 score.',
      'action=review: 只读提出重复/近重复/可能冲突候选；不会自动删除或合并，确认后仍需 read + revision mutation.',
      'action=read: 读取 search/write 返回的某个记忆文件; 只在需要深读时使用.',
      'action=list: 按 scope 列出有界文件元数据, 用于发现重复或过时记忆.',
      'action=delete: 永久删除明确指定的记忆文件; 先确认有价值内容已写入保留版本.',
      'action=update_entry/delete_entry/promote_entry/mark_disputed/supersede_entry/compact: 修改文件内记录; 先 read 取得 entryId 和最新 revision. compact 会生成 stable 记忆.',
      '可信度不接受 trust=high 这类模型自报字段; 对冲突事实用 mark_disputed，对已有替代事实用 supersede_entry 保留演化链.',
      'person/group 写入需要 id; topic 写入必须提供稳定 title，禁止落入无主题 topic.md; self 可用 title 分主题.',
      '写入要用自己的话, 不要照搬原话; 查询结果用于自然说话, 不要像报数据库.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        if (args.action === 'write') {
          const result = await writeMemoryEntry(
            storeOptions,
            {
              scope: args.scope as MemoryScope,
              id: args.id == null ? undefined : String(args.id),
              title: args.title,
              content: args.content,
              sourceMessageIds: args.sourceMessageIds,
            },
          )
          log.info({
            file: result.file,
            scope: result.scope,
            title: result.title,
            contentLength: args.content.length,
            sourceCount: args.sourceMessageIds?.length ?? 0,
            created: result.created,
            deduplicated: result.deduplicated,
          }, 'memory_written')
          if (result.created) deps.maintenance?.enqueue(result.file)
          return { content: JSON.stringify(result) }
        }

        if (args.action === 'search') {
          const result = await searchMemoryEntries(
            storeOptions,
            { scope: args.scope, keyword: args.keyword, limit: args.limit },
          )
          log.info({
            scope: args.scope ?? null,
            keyword: args.keyword ?? null,
            limit: args.limit ?? null,
            hitCount: result.matches.length,
            skippedCorrupt: result.skippedCorrupt,
          }, 'memory_searched')
          return { content: JSON.stringify(result) }
        }

        if (args.action === 'recall') {
          const result = await recallMemoryEntries(
            storeOptions,
            { query: args.query, scope: args.scope, limit: args.limit },
          )
          log.info({
            query: args.query,
            scope: args.scope ?? null,
            hitCount: result.matches.length,
            skippedCorrupt: result.skippedCorrupt,
          }, 'memory_recalled')
          return { content: JSON.stringify(result), outcome: { ok: true } }
        }

        if (args.action === 'review') {
          const result = await proposeMemoryReview(
            storeOptions,
            { scope: args.scope, file: args.file, limit: args.limit },
          )
          log.info({
            scope: args.scope ?? null,
            file: args.file ?? null,
            proposalCount: result.proposals.length,
            scannedEntries: result.scannedEntries,
          }, 'memory_review_proposed')
          return { content: JSON.stringify(result), outcome: { ok: true } }
        }

        if (args.action === 'list') {
          const result = await listMemoryFiles(
            storeOptions,
            { scope: args.scope, limit: args.limit },
          )
          log.info({
            scope: args.scope ?? null,
            limit: args.limit ?? null,
            fileCount: result.files.length,
            total: result.total,
            truncated: result.truncated,
            skippedCorrupt: result.skippedCorrupt,
          }, 'memory_listed')
          return { content: JSON.stringify(result), outcome: { ok: true } }
        }

        if (args.action === 'delete') {
          const result = await deleteMemoryFiles(
            storeOptions,
            { files: args.files },
          )
          log.info({
            requestedFiles: args.files,
            deletedCount: result.deleted.length,
            missingCount: result.missing.length,
            failedCount: result.failed.length,
          }, 'memory_deleted')
          return {
            content: JSON.stringify(result),
            outcome: result.ok
              ? { ok: true }
              : { ok: false, code: 'delete_failed', error: '部分记忆文件删除失败' },
          }
        }

        if (args.action === 'update_entry') {
          const result = await updateMemoryEntry(
            storeOptions,
            {
              file: args.file,
              entryId: args.entryId,
              expectedRevision: args.expectedRevision,
              content: args.content,
            },
          )
          log.info({ file: args.file, entryId: args.entryId }, 'memory_entry_updated')
          return { content: JSON.stringify(result), outcome: { ok: true } }
        }

        if (args.action === 'delete_entry') {
          const result = await deleteMemoryEntry(
            storeOptions,
            { file: args.file, entryId: args.entryId, expectedRevision: args.expectedRevision },
          )
          log.info({ file: args.file, entryId: args.entryId }, 'memory_entry_deleted')
          return { content: JSON.stringify(result), outcome: { ok: true } }
        }

        if (args.action === 'promote_entry') {
          const result = await promoteMemoryEntry(
            storeOptions,
            {
              file: args.file,
              entryId: args.entryId,
              expectedRevision: args.expectedRevision,
              content: args.content,
            },
          )
          log.info({ file: args.file, entryId: args.entryId }, 'memory_entry_promoted')
          return { content: JSON.stringify(result), outcome: { ok: true } }
        }

        if (args.action === 'mark_disputed') {
          const result = await markMemoryEntryDisputed(
            storeOptions,
            { file: args.file, entryId: args.entryId, expectedRevision: args.expectedRevision },
          )
          log.info({ file: args.file, entryId: args.entryId }, 'memory_entry_marked_disputed')
          return { content: JSON.stringify(result), outcome: { ok: true } }
        }

        if (args.action === 'supersede_entry') {
          const result = await supersedeMemoryEntry(
            storeOptions,
            {
              file: args.file,
              entryId: args.entryId,
              replacementEntryId: args.replacementEntryId,
              expectedRevision: args.expectedRevision,
            },
          )
          log.info({
            file: args.file,
            entryId: args.entryId,
            replacementEntryId: args.replacementEntryId,
          }, 'memory_entry_superseded')
          return { content: JSON.stringify(result), outcome: { ok: true } }
        }

        if (args.action === 'compact') {
          const result = await compactMemoryEntries(
            storeOptions,
            {
              file: args.file,
              entryIds: args.entryIds,
              expectedRevision: args.expectedRevision,
              content: args.content,
            },
          )
          log.info({
            file: args.file,
            entryId: result.entryId,
            compactedCount: args.entryIds.length,
          }, 'memory_entries_compacted')
          return { content: JSON.stringify(result), outcome: { ok: true } }
        }

        const result = await readMemoryFile(
          storeOptions,
          { file: args.file, offset: args.offset, maxChars: args.maxChars },
        )
        return { content: JSON.stringify(result) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn({ err }, 'memory_tool_failed')
        const code = err instanceof MemoryStoreError ? err.code : 'memory_failed'
        return {
          content: JSON.stringify({ ok: false, code, error: message }),
          outcome: { ok: false, code, error: message },
        }
      }
    },
  }
}

export const memoryTool: Tool<Args> = createMemoryTool()
