import { z } from 'zod'
import type { Tool } from '../tool.js'
import {
  correctMemoryEntry,
  recallMemoryEntries,
  writeMemoryEntry,
  MemoryStoreError,
  type ConversationMemoryContext,
  type MemoryScope,
} from '../memory-store.js'
import { createLogger } from '../../logger.js'
import type { MemoryMaintenanceRuntime } from '../memory-maintenance.js'
import type { WorkspaceStateCoordinator } from '../workspace-state-coordinator.js'
import { CHINESE_NARRATIVE_ERROR, hasChineseNarrative } from '../long-term-language.js'
import { createToolResultProgressTracker } from '../tool-progress.js'
import { deriveMemoryEvidence, type LoadMemorySourceEvidence } from '../memory-evidence.js'
import type { ConversationRef, ParticipantRef } from '../../chat/conversation.js'
import { conversationKey } from '../../chat/conversation.js'

const log = createLogger('TOOL_MEMORY')
const DEFAULT_WORKSPACE_DIR = 'data/agent-workspace'
const MEMORY_REF_PREFIX = 'mem1.'

const scopeSchema = z.enum(['self', 'person', 'group', 'topic'])
const idSchema = z.union([z.string(), z.number()])
const recallIdSchema = z.union([
  z.string().trim().min(1),
  z.number().int().positive().safe(),
])
const recallContextSchema = z.object({
  platform: z.enum(['qq', 'feishu']),
  accountId: z.string().min(1),
  kind: z.enum(['group', 'private']),
  externalId: z.string().min(1),
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

const memorySelectionSchema = z.object({
  v: z.literal(1),
  file: memoryFileSchema,
  entryId: z.string().trim().min(1).max(160),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
type MemorySelection = z.infer<typeof memorySelectionSchema>

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('remember').describe('写入一条长期记忆。'),
    scope: scopeSchema,
    id: idSchema.optional().describe('person 使用稳定参与者 key；group 使用 conversation key。'),
    title: chineseMemoryTitleSchema.optional().describe('topic 必填稳定中文主题标签；self 可选。'),
    content: chineseMemoryContentSchema.describe('用中文叙述，一条只记一件事。'),
    sourceMessageRowIds: z.array(z.number().int().positive()).min(1).max(20).optional()
      .describe('person/group 必填：支撑事实的真实 messages.rowId。'),
  }).strict().superRefine((value, ctx) => {
    if ((value.scope === 'person' || value.scope === 'group') && !value.sourceMessageRowIds?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceMessageRowIds'],
        message: `scope=${value.scope} remember 必须提供 sourceMessageRowIds`,
      })
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
    ref: z.string().trim().min(1).max(600).describe('来自 recall 命中项的不透明 ref。'),
    content: chineseMemoryContentSchema,
    sourceMessageRowIds: z.array(z.number().int().positive()).min(1).max(20).optional(),
  }).strict(),
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
  ownerIdentities?: readonly ParticipantRef[]
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
      'recall 命中项包含一个不透明 ref；确认事实错误时只把该 ref 与新 content 交给 correct，文件、revision 和生命周期由工具内部管理。',
      'person recall 必须传稳定参与者 ID 与当前平台 context；group recall 的 id 使用 conversation list 返回的会话 key；不传 scope/id 才跨范围探索。',
      'person/group 的 remember 或 correct 必须引用真实 sourceMessageRowIds；证据类别由工具根据消息推导。内部 maintenance 负责整理和冲突处理。',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      try {
        const selection = args.action === 'correct' ? decodeMemoryRef(args.ref) : undefined
        if (
          args.action === 'correct'
          && selection
          && isEntityMemoryFile(selection.file)
          && !args.sourceMessageRowIds?.length
        ) {
          throw new MemoryStoreError(
            'invalid_input',
            'person/group memory correction 必须提供 sourceMessageRowIds',
          )
        }
        let derivedEvidence: ReturnType<typeof deriveMemoryEvidence> | undefined
        if ('sourceMessageRowIds' in args && args.sourceMessageRowIds?.length && deps.loadSourceEvidence) {
          const rows = await deps.loadSourceEvidence(args.sourceMessageRowIds)
          const existing = new Set(rows.map((row) => row.rowId))
          const missing = args.sourceMessageRowIds.filter((id) => !existing.has(id))
          if (missing.length > 0) {
            const error = `sourceMessageRowIds contain unknown message rows: ${missing.join(',')}`
            return {
              content: JSON.stringify({ ok: false, code: 'invalid_evidence', error, missingSourceMessageRowIds: missing }),
              outcome: { ok: false, code: 'invalid_evidence', error, progress: false, continuation: 'immediate' },
            }
          }
          derivedEvidence = deriveMemoryEvidence({
            rows,
            ...(memorySubjectKey(args, selection) ? { subjectKey: memorySubjectKey(args, selection) } : {}),
            ...(deps.ownerId ? { ownerId: deps.ownerId } : {}),
            ...(deps.ownerIdentities ? { ownerIdentities: deps.ownerIdentities } : {}),
          })
          assertEvidenceContextMatchesTarget(args, selection, derivedEvidence.context)
        }

        if (args.action === 'remember') {
          const result = await writeMemoryEntry(storeOptions, {
            scope: args.scope as MemoryScope,
            id: args.id == null ? undefined : String(args.id),
            ...((args.scope === 'person' || args.scope === 'group') && derivedEvidence
              ? { context: toStoreContext(derivedEvidence.context) }
              : {}),
            title: args.title,
            content: args.content,
            sourceMessageRowIds: args.sourceMessageRowIds,
            assertedByIds: derivedEvidence?.assertedByIds,
            evidenceKind: derivedEvidence?.evidenceKind,
          })
          log.info({ file: result.file, scope: result.scope, created: result.created }, 'memory_remembered')
          if (result.created) deps.maintenance?.enqueue(result.file)
          return {
            content: JSON.stringify({ ok: true, changed: result.changed, created: result.created }),
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
          return observedMemoryResult(
            progress,
            `recall:${JSON.stringify(args)}`,
            toPublicRecallResult(result),
          )
        }

        const result = await correctMemoryEntry(storeOptions, {
          file: selection!.file,
          entryId: selection!.entryId,
          expectedRevision: selection!.revision,
          content: args.content,
          sourceMessageRowIds: args.sourceMessageRowIds,
          assertedByIds: derivedEvidence?.assertedByIds,
          evidenceKind: derivedEvidence?.evidenceKind,
        })
        log.info({
          file: selection!.file,
          oldEntryId: selection!.entryId,
          replacementEntryId: result.replacementEntryId,
        }, 'memory_corrected')
        return {
          content: JSON.stringify({ ok: true, changed: true }),
          outcome: { ok: true, code: 'corrected', progress: true },
        }
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

function memorySubjectKey(args: Args, selection?: MemorySelection): string | undefined {
  if (args.action === 'remember' && args.scope === 'person') {
    const id = String(args.id ?? '')
    if (id === 'owner') return 'owner'
    return id
  }
  if (args.action === 'correct' && selection) {
    const encoded = /^people\/([^/]+)\//.exec(selection.file)?.[1]
    return encoded ? decodeURIComponent(encoded) : undefined
  }
  return undefined
}

function toMemoryContext(value: ConversationRef): ConversationMemoryContext {
  return { kind: 'conversation', conversation: value }
}

function toStoreContext(
  context: ReturnType<typeof deriveMemoryEvidence>['context'],
): ConversationMemoryContext | { kind: 'core' } {
  return context.kind === 'owner_core'
    ? { kind: 'core' }
    : { kind: 'conversation', conversation: context.conversation }
}

function assertEvidenceContextMatchesTarget(
  args: Args,
  selection: MemorySelection | undefined,
  context: ReturnType<typeof deriveMemoryEvidence>['context'],
): void {
  if (context.kind === 'owner_core') return
  if (args.action === 'remember' && args.scope === 'group') {
    if (
      context.conversation.kind !== 'group'
      || conversationKey(context.conversation) !== String(args.id ?? '')
    ) {
      throw new MemoryStoreError('invalid_input', 'group memory evidence must come from the same group')
    }
    return
  }
  if (args.action !== 'correct' || !selection) return
  const conversation = /^people\/[^/]+\/conversations\/([^/]+)\.md$/.exec(selection.file)
  const groupFile = /^groups\/([^/]+)\.md$/.exec(selection.file)
  const encodedKey = encodeURIComponent(conversationKey(context.conversation))
  if (conversation && encodedKey !== conversation[1]) {
    throw new MemoryStoreError('invalid_input', 'person memory evidence context does not match the target conversation file')
  }
  if (groupFile && (context.conversation.kind !== 'group' || encodedKey !== groupFile[1])) {
    throw new MemoryStoreError('invalid_input', 'group memory evidence must come from the same group')
  }
}

function isEntityMemoryFile(file: string): boolean {
  return /^(?:people|groups)\//.test(file)
}

function encodeMemoryRef(selection: MemorySelection): string {
  return `${MEMORY_REF_PREFIX}${Buffer.from(JSON.stringify(selection), 'utf8').toString('base64url')}`
}

function decodeMemoryRef(ref: string): MemorySelection {
  if (!ref.startsWith(MEMORY_REF_PREFIX)) {
    throw new MemoryStoreError('invalid_selection', 'memory ref 无效；请重新 recall')
  }
  try {
    const parsed = JSON.parse(Buffer.from(ref.slice(MEMORY_REF_PREFIX.length), 'base64url').toString('utf8'))
    const result = memorySelectionSchema.safeParse(parsed)
    if (result.success) return result.data
  } catch {
    // Fall through to one stable public error.
  }
  throw new MemoryStoreError('invalid_selection', 'memory ref 无效；请重新 recall')
}

function toPublicRecallResult(result: Awaited<ReturnType<typeof recallMemoryEntries>>) {
  return {
    ok: true as const,
    matches: result.matches.map((match) => ({
      ref: encodeMemoryRef({
        v: 1,
        file: match.file,
        entryId: match.entryId,
        revision: match.revision,
      }),
      scope: match.scope,
      title: match.title,
      content: match.content,
      createdAt: match.createdAt,
      updatedAt: match.updatedAt,
      sourceMessageRowIds: match.sourceMessageRowIds,
      ...(match.context ? { context: match.context } : {}),
    })),
    skippedCorrupt: result.skippedCorrupt,
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
