import { z } from 'zod'
import type { Tool } from '../tool.js'
import {
  compactMemoryEntries,
  correctMemoryEntry,
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
  type ConversationMemoryContext,
  type MemoryEvidenceKind,
  type MemoryKind,
  type MemoryScope,
} from '../memory-store.js'
import { createLogger } from '../../logger.js'
import type { MemoryMaintenanceRuntime } from '../memory-maintenance.js'
import type { WorkspaceStateCoordinator } from '../workspace-state-coordinator.js'
import { CHINESE_NARRATIVE_ERROR, hasChineseNarrative } from '../long-term-language.js'
import { createToolResultProgressTracker } from '../tool-progress.js'
import { deriveMemoryEvidence, type LoadMemorySourceEvidence } from '../memory-evidence.js'

const log = createLogger('TOOL_MEMORY')

function topicMemoryShareCandidate(
  file: string,
  entryId: string,
  revision: string,
  summary: string,
) {
  return file === 'topics/topics.md'
    ? {
        shareCandidate: {
          key: `memory:${file}:${entryId}:${revision}`,
          cooldownKey: `memory:${file}:${entryId}`,
          summary,
        },
      }
    : {}
}

const DEFAULT_WORKSPACE_DIR = 'data/agent-workspace'

const scopeSchema = z.enum(['self', 'person', 'group', 'topic'])
const evidenceKindSchema = z.enum([
  'self_report', 'owner_assertion', 'third_party_report', 'observed_pattern', 'explicit_rule',
])
const personMemoryKindSchema = z.enum([
  'person_identity', 'person_preference', 'person_behavior', 'person_relationship',
])
const groupMemoryKindSchema = z.enum([
  'group_rule', 'group_rhythm', 'group_topic', 'group_culture', 'group_history', 'group_structure',
])
const idSchema = z.union([z.string(), z.number()])
const recallIdSchema = z.union([
  z.string().trim().min(1).regex(/^[A-Za-z0-9_-]+$/),
  z.number().int().positive().safe(),
])
const recallContextSchema = z.object({
  type: z.enum(['group', 'private']),
  id: recallIdSchema,
})
const memoryFileSchema = z.string().trim().min(1).max(200).refine(
  (file) => file.endsWith('.md')
    && !file.startsWith('/')
    && !file.includes('\\')
    && !file.split('/').includes('..'),
  '必须是 memory 内的 .md 相对路径',
).describe('memory 内的 .md 相对路径, 必须来自 memory list/search/read 结果; 不允许绝对路径、反斜杠或 .. 路径段.')
const chineseMemoryContentSchema = (max: number) => z.string().trim().min(1).max(max)
  .refine(hasChineseNarrative, CHINESE_NARRATIVE_ERROR)
const chineseMemoryTitleSchema = z.string().trim().min(1).max(80)
  .refine(hasChineseNarrative, CHINESE_NARRATIVE_ERROR)

function requireEvidenceForEntityFile(
  value: { file: string; sourceMessageIds?: number[] },
  ctx: z.RefinementCtx,
): void {
  if (/^(?:people|groups)\//.test(value.file) && !value.sourceMessageIds?.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['sourceMessageIds'],
      message: 'people/groups memory mutation 必须提供 sourceMessageIds',
    })
  }
}

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('write').describe('写入一条长期记忆.'),
    scope: scopeSchema.describe('记忆范围: self=自己做事/经验, person=某个 QQ 用户, group=某个群, topic=某个主题.'),
    id: idSchema.optional().describe('person/group 需要: QQ 号或群号. topic/self 通常不需要.'),
    title: chineseMemoryTitleSchema.optional().describe('topic 必填稳定中文主题标签; self 可选. 标签保存在 entry aliases 中用于召回，不会新建文件；专有名词可保留原文，但要用中文说明.'),
    content: chineseMemoryContentSchema(500).describe('要记下来的内容. ≤500 字, 以中文为叙述载体，用自己的话写，一条记一件事；命令、路径、API 名和专有名词保留原文.'),
    sourceMessageIds: z.array(z.number().int().positive()).min(1).max(20).optional()
      .describe('person/group 必填: 支撑这条事实的真实 messages.id；self/topic 可选.'),
    memoryKind: z.union([personMemoryKindSchema, groupMemoryKindSchema]).optional()
      .describe('person/group 必填：人物属性或群体级规则、节奏、话题、文化、历史、结构。'),
    evidenceKind: evidenceKindSchema.optional().describe('可选证据语义；runtime 会按真实消息发送者校验。'),
  }).superRefine((value, ctx) => {
    if ((value.scope === 'person' || value.scope === 'group') && !value.sourceMessageIds?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceMessageIds'],
        message: `scope=${value.scope} write 必须提供 sourceMessageIds`,
      })
    }
    if (value.scope === 'person' && !personMemoryKindSchema.safeParse(value.memoryKind).success) {
      ctx.addIssue({ code: 'custom', path: ['memoryKind'], message: 'person write 必须提供 person_* memoryKind' })
    }
    if (value.scope === 'group' && !groupMemoryKindSchema.safeParse(value.memoryKind).success) {
      ctx.addIssue({ code: 'custom', path: ['memoryKind'], message: 'group write 必须提供 group_* memoryKind' })
    }
  }),
  z.object({
    action: z.literal('search').describe('搜索长期记忆.'),
    scope: scopeSchema.optional().describe('可选: 限定搜索范围.'),
    keyword: z.string().trim().min(1).max(100).optional().describe('可选: 关键词. 不传则按更新时间返回最近文件摘要.'),
    limit: z.number().int().min(1).max(20).optional().describe('可选: 最多返回多少条 (1-20, 默认 10).'),
  }),
  z.object({
    action: z.literal('recall').describe('按相关性召回 entry 级长期记忆并返回可解释分数.'),
    query: z.string().trim().min(1).max(300).describe('描述要回忆的旧事、偏好、事实或经验.'),
    scope: scopeSchema.optional().describe('person/group 定向召回时必填；不传则跨 scope 宽泛探索.'),
    id: recallIdSchema.optional().describe('scope=person 时传具体 QQ 号；scope=group 时传具体群号.'),
    context: recallContextSchema.optional().describe('scope=person 必填：当前群或私聊场景；只召回人物 core 与该场景观察。'),
    limit: z.number().int().min(1).max(20).optional(),
  }).superRefine((value, ctx) => {
    if ((value.scope === 'person' || value.scope === 'group') && value.id == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: `scope=${value.scope} recall 必须提供 id`,
      })
    }
    if (value.scope === 'person' && value.context == null) {
      ctx.addIssue({ code: 'custom', path: ['context'], message: 'scope=person recall 必须提供当前 context' })
    }
    if (value.scope !== 'person' && value.context != null) {
      ctx.addIssue({ code: 'custom', path: ['context'], message: '只有 scope=person recall 可以提供 context' })
    }
    if ((value.scope === 'self' || value.scope === 'topic') && value.id != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: `scope=${value.scope} recall 不允许提供 id`,
      })
    }
    if (value.scope == null && value.id != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: '不传 scope 的全局 recall 不允许提供 id',
      })
    }
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
    content: chineseMemoryContentSchema(500),
    sourceMessageIds: z.array(z.number().int().positive()).min(1).max(20).optional(),
  }).superRefine(requireEvidenceForEntityFile),
  z.object({
    action: z.literal('correct_entry').describe('原子替代一条错误事实：旧条目标为 superseded，并新建带证据的 replacement.'),
    file: memoryFileSchema,
    entryId: z.string().trim().min(1).max(160),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    content: chineseMemoryContentSchema(500),
    sourceMessageIds: z.array(z.number().int().positive()).min(1).max(20).optional(),
  }).superRefine(requireEvidenceForEntityFile),
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
    content: chineseMemoryContentSchema(1000).optional(),
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
    content: chineseMemoryContentSchema(2000),
  }),
])

type Args = z.infer<typeof argsSchema>

export interface MemoryToolDeps {
  workspaceDir?: string
  now?: () => Date
  id?: () => string
  maintenance?: MemoryMaintenanceRuntime
  workspaceStateCoordinator?: WorkspaceStateCoordinator
  loadSourceEvidence?: LoadMemorySourceEvidence
  ownerId?: string
}

export function createMemoryTool(deps: MemoryToolDeps = {}): Tool<Args> {
  const workspaceDir = deps.workspaceDir ?? DEFAULT_WORKSPACE_DIR
  const storeOptions = {
    rootDir: workspaceDir,
    now: deps.now,
    id: deps.id,
    workspaceStateCoordinator: deps.workspaceStateCoordinator,
  }
  const progress = createToolResultProgressTracker()

  return {
    name: 'memory',
    description: [
      '本地 Markdown 长期记忆库。上下文不足且涉及旧事、偏好、稳定事实或经验时 recall；上下文足够时不要重复 recall。写前先 recall，已有事实优先修改或 compact。',
      'person recall 必须传 QQ 与当前 group/private context；group recall 传群 id；不传 scope/id 才跨范围探索。',
      'search 只做宽泛的文件发现，recall 取得可回答的 entry；review 只读。修改前 read 最新 entryId/revision；删除前保留有价值内容。',
      'person/group 写入或修正必须引用真实 sourceMessageIds。人物事实写 person；group 只写群体规则、节奏、话题、文化、历史或结构。',
      '错误用 correct_entry 保留旧条目；冲突用 mark_disputed，替代用 supersede_entry。不要自报 trust。',
      'person/group 需要 id；topic 需要稳定 title。title/content 用中文叙述，专有名词可保留原文；用自己的话写。',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        let derivedEvidence: ReturnType<typeof deriveMemoryEvidence> | undefined
        if ('sourceMessageIds' in args && args.sourceMessageIds?.length && deps.loadSourceEvidence) {
          const rows = await deps.loadSourceEvidence(args.sourceMessageIds)
          const existing = new Set(rows.map((row) => row.rowId))
          const missing = args.sourceMessageIds.filter((id) => !existing.has(id))
          if (missing.length > 0) {
            const error = `sourceMessageIds contain unknown message rows: ${missing.join(',')}`
            return {
              content: JSON.stringify({ ok: false, code: 'invalid_evidence', error, missingSourceMessageIds: missing }),
              outcome: {
                ok: false,
                code: 'invalid_evidence',
                error,
                progress: false,
                retryClass: 'immediate',
              },
            }
          }
          const subjectId = memorySubjectId(args)
          derivedEvidence = deriveMemoryEvidence({
            rows,
            ...(subjectId ? { subjectId } : {}),
            ...(deps.ownerId ? { ownerId: deps.ownerId } : {}),
            ...('evidenceKind' in args && args.evidenceKind ? { requestedKind: args.evidenceKind } : {}),
          })
          assertEvidenceContextMatchesTarget(args, derivedEvidence.context)
        }

        if (args.action === 'write') {
          const result = await writeMemoryEntry(
            storeOptions,
            {
              scope: args.scope as MemoryScope,
              id: args.id == null ? undefined : String(args.id),
              ...(args.scope === 'person' && derivedEvidence ? { context: derivedEvidence.context } : {}),
              title: args.title,
              content: args.content,
              sourceMessageIds: args.sourceMessageIds,
              assertedByIds: derivedEvidence?.assertedByIds,
              evidenceKind: derivedEvidence?.evidenceKind,
              memoryKind: args.memoryKind as MemoryKind | undefined,
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
          return {
            content: JSON.stringify(result),
            outcome: {
              ok: true,
              code: result.changed ? 'written' : 'unchanged',
              progress: result.changed,
              ...(result.changed && args.scope === 'topic' ? {
                shareCandidate: {
                  key: `memory:${result.file}:${result.entryId}:${result.revision}`,
                  cooldownKey: `memory:${result.file}:${result.entryId}`,
                  summary: `主题记忆“${result.title}”形成了一项新的稳定结论。`,
                },
              } : {}),
            },
          }
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
          return observedMemoryResult(progress, `search:${JSON.stringify(args)}`, result)
        }

        if (args.action === 'recall') {
          const result = await recallMemoryEntries(
            storeOptions,
            {
              query: args.query,
              scope: args.scope,
              id: args.id == null ? undefined : String(args.id),
              ...(args.context ? { context: toMemoryContext(args.context) } : {}),
              limit: args.limit,
            },
          )
          log.info({
            query: args.query,
            scope: args.scope ?? null,
            id: args.id == null ? null : String(args.id),
            hitCount: result.matches.length,
            skippedCorrupt: result.skippedCorrupt,
          }, 'memory_recalled')
          return observedMemoryResult(progress, `recall:${JSON.stringify(args)}`, result)
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
          return observedMemoryResult(progress, `review:${JSON.stringify(args)}`, result)
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
          return observedMemoryResult(progress, `list:${JSON.stringify(args)}`, result)
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
              ? {
                  ok: true,
                  code: result.deleted.length > 0 ? 'deleted' : 'unchanged',
                  progress: result.deleted.length > 0,
                }
              : {
                  ok: false,
                  code: 'delete_failed',
                  error: '部分记忆文件删除失败',
                  progress: result.deleted.length > 0,
                  retryClass: 'immediate',
                },
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
              sourceMessageIds: args.sourceMessageIds,
              assertedByIds: derivedEvidence?.assertedByIds,
              evidenceKind: derivedEvidence?.evidenceKind,
            },
          )
          log.info({ file: args.file, entryId: args.entryId }, 'memory_entry_updated')
          return {
            content: JSON.stringify(result),
            outcome: {
              ok: true,
              code: 'updated',
              progress: true,
              ...topicMemoryShareCandidate(
                args.file,
                result.entryId,
                result.revision,
                '主题记忆形成了一项更新后的稳定结论。',
              ),
            },
          }
        }

        if (args.action === 'correct_entry') {
          const result = await correctMemoryEntry(
            storeOptions,
            {
              file: args.file,
              entryId: args.entryId,
              expectedRevision: args.expectedRevision,
              content: args.content,
              sourceMessageIds: args.sourceMessageIds,
              assertedByIds: derivedEvidence?.assertedByIds,
              evidenceKind: derivedEvidence?.evidenceKind,
            },
          )
          log.info({
            file: args.file,
            oldEntryId: args.entryId,
            replacementEntryId: result.replacementEntryId,
          }, 'memory_entry_corrected')
          return {
            content: JSON.stringify(result),
            outcome: {
              ok: true,
              code: 'corrected',
              progress: true,
              ...topicMemoryShareCandidate(
                args.file,
                result.replacementEntryId,
                result.revision,
                '主题记忆纠正了一项旧结论。',
              ),
            },
          }
        }

        if (args.action === 'delete_entry') {
          const result = await deleteMemoryEntry(
            storeOptions,
            { file: args.file, entryId: args.entryId, expectedRevision: args.expectedRevision },
          )
          log.info({ file: args.file, entryId: args.entryId }, 'memory_entry_deleted')
          return { content: JSON.stringify(result), outcome: { ok: true, code: 'deleted', progress: true } }
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
          return {
            content: JSON.stringify(result),
            outcome: {
              ok: true,
              code: 'promoted',
              progress: true,
              ...topicMemoryShareCandidate(
                args.file,
                result.entryId,
                result.revision,
                '主题记忆沉淀了一项稳定结论。',
              ),
            },
          }
        }

        if (args.action === 'mark_disputed') {
          const result = await markMemoryEntryDisputed(
            storeOptions,
            { file: args.file, entryId: args.entryId, expectedRevision: args.expectedRevision },
          )
          log.info({ file: args.file, entryId: args.entryId }, 'memory_entry_marked_disputed')
          return { content: JSON.stringify(result), outcome: { ok: true, code: 'disputed', progress: true } }
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
          return { content: JSON.stringify(result), outcome: { ok: true, code: 'superseded', progress: true } }
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
          return {
            content: JSON.stringify(result),
            outcome: {
              ok: true,
              code: 'compacted',
              progress: true,
              ...topicMemoryShareCandidate(
                args.file,
                result.entryId,
                result.revision,
                '主题记忆完成了一次结论整合。',
              ),
            },
          }
        }

        const result = await readMemoryFile(
          storeOptions,
          { file: args.file, offset: args.offset, maxChars: args.maxChars },
        )
        if (!result.ok) {
          return {
            content: JSON.stringify(result),
            outcome: {
              ok: false,
              code: 'not_found',
              error: result.error,
              progress: false,
              retryClass: 'immediate',
            },
          }
        }
        return observedMemoryResult(progress, `read:${JSON.stringify(args)}`, result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn({ err }, 'memory_tool_failed')
        const code = err instanceof MemoryStoreError ? err.code : 'memory_failed'
        let recovery: Record<string, unknown> = {}
        if (code === 'revision_conflict' && 'file' in args && typeof args.file === 'string') {
          const latest = await readMemoryFile(storeOptions, { file: args.file, maxChars: 500 })
          if (latest.ok) {
            recovery = {
              latestRevision: latest.revision,
              currentEntry: 'entryId' in args
                ? latest.entries.find((entry) => entry.id === args.entryId) ?? null
                : null,
            }
          }
        }
        return {
          content: JSON.stringify({ ok: false, code, error: message, ...recovery }),
          outcome: {
            ok: false,
            code,
            error: message,
            progress: false,
            retryClass: code === 'memory_failed' ? 'backoff' : 'immediate',
          },
        }
      }
    },
  }
}

function memorySubjectId(args: Args): string | undefined {
  if (args.action === 'write' && args.scope === 'person') return String(args.id ?? '')
  if (args.action === 'update_entry' || args.action === 'correct_entry') {
    return /^people\/([^/]+)\//.exec(args.file)?.[1]
  }
  return undefined
}

function toMemoryContext(value: { type: 'group' | 'private'; id: string | number }): ConversationMemoryContext {
  return value.type === 'group'
    ? { kind: 'qq_group', id: String(value.id) }
    : { kind: 'qq_private', id: String(value.id) }
}

function assertEvidenceContextMatchesTarget(
  args: Args,
  context: ConversationMemoryContext,
): void {
  if (args.action === 'write' && args.scope === 'group') {
    if (context.kind !== 'qq_group' || context.id !== String(args.id ?? '')) {
      throw new MemoryStoreError('invalid_input', 'group memory evidence must come from the same group')
    }
    return
  }
  if (args.action !== 'update_entry' && args.action !== 'correct_entry') return
  const group = /^people\/[^/]+\/groups\/([^/]+)\.md$/.exec(args.file)
  const privatePeer = /^people\/[^/]+\/private\/([^/]+)\.md$/.exec(args.file)
  const groupFile = /^groups\/([^/]+)\.md$/.exec(args.file)
  if (group && (context.kind !== 'qq_group' || context.id !== group[1])) {
    throw new MemoryStoreError('invalid_input', 'person memory evidence context does not match the target group file')
  }
  if (privatePeer && (context.kind !== 'qq_private' || context.id !== privatePeer[1])) {
    throw new MemoryStoreError('invalid_input', 'person memory evidence context does not match the target private file')
  }
  if (groupFile && (context.kind !== 'qq_group' || context.id !== groupFile[1])) {
    throw new MemoryStoreError('invalid_input', 'group memory evidence must come from the same group')
  }
}

function observedMemoryResult(
  tracker: ReturnType<typeof createToolResultProgressTracker>,
  key: string,
  result: unknown,
) {
  const content = JSON.stringify(result)
  const changed = tracker.observe(key, content)
  return {
    content,
    outcome: { ok: true as const, code: changed ? 'observed' : 'unchanged', progress: changed },
  }
}

export const memoryTool: Tool<Args> = createMemoryTool()
