import { z } from 'zod'
import type { Tool } from '../tool.js'
import {
  correctMemoryEntry,
  recallMemoryEntries,
  writeMemoryEntry,
  MemoryStoreError,
  type ConversationMemoryContext,
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
}).strict()
const memoryFileSchema = z.string().trim().min(1).max(200).refine(
  (file) => file.endsWith('.md')
    && !file.startsWith('/')
    && !file.includes('\\')
    && !file.split('/').includes('..'),
  '必须是 recall 返回的 memory 内 .md 相对路径',
)
const chineseMemoryContentSchema = z.string().trim().min(1).max(500)
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
      message: 'people/groups memory correction 必须提供 sourceMessageIds',
    })
  }
}

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('remember').describe('写入一条长期记忆。'),
    scope: scopeSchema,
    id: idSchema.optional().describe('person/group 需要 QQ 号或群号。'),
    title: chineseMemoryTitleSchema.optional().describe('topic 必填稳定中文主题标签；self 可选。'),
    content: chineseMemoryContentSchema.describe('用中文叙述，一条只记一件事。'),
    sourceMessageIds: z.array(z.number().int().positive()).min(1).max(20).optional()
      .describe('person/group 必填：支撑事实的真实 messages.id。'),
    memoryKind: z.union([personMemoryKindSchema, groupMemoryKindSchema]).optional(),
    evidenceKind: evidenceKindSchema.optional(),
  }).strict().superRefine((value, ctx) => {
    if ((value.scope === 'person' || value.scope === 'group') && !value.sourceMessageIds?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceMessageIds'],
        message: `scope=${value.scope} remember 必须提供 sourceMessageIds`,
      })
    }
    if (value.scope === 'person' && !personMemoryKindSchema.safeParse(value.memoryKind).success) {
      ctx.addIssue({ code: 'custom', path: ['memoryKind'], message: 'person remember 必须提供 person_* memoryKind' })
    }
    if (value.scope === 'group' && !groupMemoryKindSchema.safeParse(value.memoryKind).success) {
      ctx.addIssue({ code: 'custom', path: ['memoryKind'], message: 'group remember 必须提供 group_* memoryKind' })
    }
  }),
  z.object({
    action: z.literal('recall').describe('按相关性召回长期记忆。'),
    query: z.string().trim().min(1).max(300),
    scope: scopeSchema.optional(),
    id: recallIdSchema.optional(),
    context: recallContextSchema.optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }).strict().superRefine((value, ctx) => {
    if ((value.scope === 'person' || value.scope === 'group') && value.id == null) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: `scope=${value.scope} recall 必须提供 id` })
    }
    if (value.scope === 'person' && value.context == null) {
      ctx.addIssue({ code: 'custom', path: ['context'], message: 'scope=person recall 必须提供当前 context' })
    }
    if (value.scope !== 'person' && value.context != null) {
      ctx.addIssue({ code: 'custom', path: ['context'], message: '只有 scope=person recall 可以提供 context' })
    }
    if ((value.scope === 'self' || value.scope === 'topic') && value.id != null) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: `scope=${value.scope} recall 不允许提供 id` })
    }
    if (value.scope == null && value.id != null) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: '不传 scope 的全局 recall 不允许提供 id' })
    }
  }),
  z.object({
    action: z.literal('correct').describe('原子替代一条错误事实，并保留旧事实的可追溯关系。'),
    file: memoryFileSchema.describe('来自 recall 命中项的 file。'),
    entryId: z.string().trim().min(1).max(160).describe('来自 recall 命中项的 entryId。'),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/)
      .describe('来自同一次 recall 命中项的 revision。'),
    content: chineseMemoryContentSchema,
    sourceMessageIds: z.array(z.number().int().positive()).min(1).max(20).optional(),
  }).strict().superRefine(requireEvidenceForEntityFile),
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
      '长期记忆只提供 remember、recall、correct 三个动作。',
      '上下文不足且涉及旧事、偏好、稳定事实或经验时 recall；写前先 recall，避免重复。',
      'recall 命中项直接包含 file、entryId 和 revision；确认事实错误时用这三项调用 correct。',
      'person recall 必须传 QQ 与当前 group/private context；group recall 传群 id；不传 scope/id 才跨范围探索。',
      'person/group 的 remember 或 correct 必须引用真实 sourceMessageIds。内部 maintenance 负责 review、promote、compact 和冲突整理。',
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
              outcome: { ok: false, code: 'invalid_evidence', error, progress: false, continuation: 'immediate' },
            }
          }
          derivedEvidence = deriveMemoryEvidence({
            rows,
            ...(memorySubjectId(args) ? { subjectId: memorySubjectId(args) } : {}),
            ...(deps.ownerId ? { ownerId: deps.ownerId } : {}),
            ...('evidenceKind' in args && args.evidenceKind ? { requestedKind: args.evidenceKind } : {}),
          })
          assertEvidenceContextMatchesTarget(args, derivedEvidence.context)
        }

        if (args.action === 'remember') {
          const result = await writeMemoryEntry(storeOptions, {
            scope: args.scope as MemoryScope,
            id: args.id == null ? undefined : String(args.id),
            ...(args.scope === 'person' && derivedEvidence ? { context: derivedEvidence.context } : {}),
            title: args.title,
            content: args.content,
            sourceMessageIds: args.sourceMessageIds,
            assertedByIds: derivedEvidence?.assertedByIds,
            evidenceKind: derivedEvidence?.evidenceKind,
            memoryKind: args.memoryKind as MemoryKind | undefined,
          })
          log.info({ file: result.file, scope: result.scope, created: result.created }, 'memory_remembered')
          if (result.created) deps.maintenance?.enqueue(result.file)
          return {
            content: JSON.stringify(result),
            outcome: { ok: true, code: result.changed ? 'remembered' : 'unchanged', progress: result.changed },
          }
        }

        if (args.action === 'recall') {
          const result = await recallMemoryEntries(storeOptions, {
            query: args.query,
            scope: args.scope,
            id: args.id == null ? undefined : String(args.id),
            ...(args.context ? { context: toMemoryContext(args.context) } : {}),
            limit: args.limit,
          })
          log.info({ query: args.query, hitCount: result.matches.length }, 'memory_recalled')
          return observedMemoryResult(progress, `recall:${JSON.stringify(args)}`, result)
        }

        const result = await correctMemoryEntry(storeOptions, {
          file: args.file,
          entryId: args.entryId,
          expectedRevision: args.expectedRevision,
          content: args.content,
          sourceMessageIds: args.sourceMessageIds,
          assertedByIds: derivedEvidence?.assertedByIds,
          evidenceKind: derivedEvidence?.evidenceKind,
        })
        log.info({
          file: args.file,
          oldEntryId: args.entryId,
          replacementEntryId: result.replacementEntryId,
        }, 'memory_corrected')
        return { content: JSON.stringify(result), outcome: { ok: true, code: 'corrected', progress: true } }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof MemoryStoreError ? error.code : 'memory_failed'
        log.warn({ error }, 'memory_tool_failed')
        return {
          content: JSON.stringify({ ok: false, code, error: message }),
          outcome: {
            ok: false,
            code,
            error: message,
            progress: false,
            continuation: code === 'memory_failed' ? 'backoff' : 'immediate',
          },
        }
      }
    },
  }
}

function memorySubjectId(args: Args): string | undefined {
  if (args.action === 'remember' && args.scope === 'person') return String(args.id ?? '')
  if (args.action === 'correct') return /^people\/([^/]+)\//.exec(args.file)?.[1]
  return undefined
}

function toMemoryContext(value: { type: 'group' | 'private'; id: string | number }): ConversationMemoryContext {
  return value.type === 'group'
    ? { kind: 'qq_group', id: String(value.id) }
    : { kind: 'qq_private', id: String(value.id) }
}

function assertEvidenceContextMatchesTarget(args: Args, context: ConversationMemoryContext): void {
  if (args.action === 'remember' && args.scope === 'group') {
    if (context.kind !== 'qq_group' || context.id !== String(args.id ?? '')) {
      throw new MemoryStoreError('invalid_input', 'group memory evidence must come from the same group')
    }
    return
  }
  if (args.action !== 'correct') return
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
