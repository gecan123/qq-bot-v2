import '@tanstack/react-start/server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { MemoryEvidenceRow } from '../../../../../src/agent/memory-evidence.js'
import { assertBotStopped, inspectBotProcessGuard } from '../../../../../src/ops/bot-process-guard.js'
import {
  migrateLongTermStateToChinese,
  planLongTermStateLanguageMigration,
  type LongTermStateLanguageMigrationResult,
  type LongTermStateLanguageMigrationPlan,
  type LongTermTranslation,
  type LongTermTranslationItem,
} from '../../../../../src/ops/long-term-state-language-migration.js'
import { createLongTermStateTranslator } from '../../../../../src/ops/long-term-state-language-translator.js'
import { canonicalizeSelfTopicMemory } from '../../../../../src/ops/memory-canonicalization.js'
import { migrateMemoryToV2 } from '../../../../../src/ops/memory-v2-migration.js'
import {
  previewAgentStateReset,
  resetAgentState,
  type AgentStateResetDb,
  type AgentStateResetPreviewDb,
} from '../../../../../src/ops/reset-agent-state.js'
import { getAdminPrisma } from '../../server/db.server.js'
import { getRepositoryRoot, getWorkspaceRoot } from '../../server/paths.server.js'
import { createOperationRunFileStore } from './operation-run-store.server.js'
import { createOperationRunner, type OperationRunStart } from './operation-runner.js'
import {
  botProcessStatusSchema,
  operationRunIdRequestSchema,
  operationsSnapshotSchema,
  operationStartRequestSchema,
  type BotProcessStatusDto,
  type OperationPreview,
  type OperationRequest,
  type OperationRun,
  type OperationsSnapshot,
} from './operations.schema.js'
import {
  AdminOperationError,
  createAdminOperationsService,
  type AdminOperationsPort,
} from './operations.service.js'

type LanguageTranslator = (
  items: readonly LongTermTranslationItem[],
  onProgress?: (progress: { completedBatches: number; totalBatches: number }) => void,
) => Promise<readonly LongTermTranslation[]>

interface AdminOperationsDb extends AgentStateResetDb, AgentStateResetPreviewDb {}

export interface AdminOperationsAdapterDependencies {
  repositoryRoot: string
  workspaceRoot: string
  db: AdminOperationsDb
  loadMemoryEvidence(ids: readonly number[]): Promise<MemoryEvidenceRow[]>
  inspectBot(repositoryRoot: string): Promise<BotProcessStatusDto>
  assertBotStopped(repositoryRoot: string): Promise<void>
  previewAgentStateReset: typeof previewAgentStateReset
  resetAgentState: typeof resetAgentState
  migrateMemoryToV2: typeof migrateMemoryToV2
  canonicalizeSelfTopicMemory: typeof canonicalizeSelfTopicMemory
  planLongTermStateLanguageMigration(
    input: { rootDir: string },
  ): Promise<LongTermStateLanguageMigrationPlan>
  createLanguageTranslator(): Promise<LanguageTranslator>
  migrateLongTermStateToChinese(input: {
    rootDir: string
    translate(items: readonly LongTermTranslationItem[]): Promise<readonly LongTermTranslation[]>
  }): Promise<LongTermStateLanguageMigrationResult>
}

export function createAdminOperationsPort(
  dependencies: AdminOperationsAdapterDependencies,
): AdminOperationsPort {
  return {
    inspectBot: () => dependencies.inspectBot(dependencies.repositoryRoot),

    async preview(request) {
      switch (request.operation) {
        case 'reset_state': {
          const result = await dependencies.previewAgentStateReset({
            scope: request.scope,
            workspaceDir: dependencies.workspaceRoot,
            ...(request.scope === 'knowledge' ? {} : { db: dependencies.db }),
          })
          const knowledgeNeeded = result.knowledge?.directories.some(directory => directory.exists) ?? false
          const contextNeeded = result.context
            ? Object.values(result.context).some(count => count > 0)
            : false
          return {
            payload: {
              operation: 'reset_state',
              scope: request.scope,
              needed: contextNeeded || knowledgeNeeded,
              context: result.context ?? null,
              knowledge: result.knowledge ?? null,
            },
            stateFingerprint: hashState(result),
          }
        }
        case 'migrate_memory_v2': {
          const result = await dependencies.migrateMemoryToV2({
            rootDir: dependencies.workspaceRoot,
            loadSourceEvidence: dependencies.loadMemoryEvidence,
          })
          return {
            payload: {
              operation: 'migrate_memory_v2',
              needed: result.needed,
              filesBefore: result.filesBefore,
              filesAfter: result.filesAfter,
              entries: result.entries,
              movedPersonEntries: result.movedPersonEntries,
              quarantinedPersonEntries: result.quarantinedPersonEntries,
              changes: result.changes.slice(0, 50),
              warnings: result.warnings.slice(0, 20).map(warning => warning.slice(0, 500)),
              truncated: {
                changes: Math.max(0, result.changes.length - 50),
                warnings: Math.max(0, result.warnings.length - 20),
              },
            },
            stateFingerprint: result.stateFingerprint,
          }
        }
        case 'canonicalize_memory': {
          const result = await dependencies.canonicalizeSelfTopicMemory({
            rootDir: dependencies.workspaceRoot,
          })
          const sourceFiles = [...result.sourceFiles].sort()
          const targetFiles = [...result.targets].sort()
          return {
            payload: {
              operation: 'canonicalize_memory',
              needed: result.needed,
              filesBefore: result.filesBefore,
              filesAfter: result.filesAfter,
              entries: result.entries,
              consolidatedFiles: result.consolidatedFiles,
              sourceFiles,
              targetFiles,
            },
            stateFingerprint: result.stateFingerprint,
          }
        }
        case 'migrate_state_language': {
          const result = await dependencies.planLongTermStateLanguageMigration({
            rootDir: dependencies.workspaceRoot,
          })
          return {
            payload: {
              operation: 'migrate_state_language',
              needed: result.totalItems > 0 || result.repairableJournalEntries > 0,
              totalItems: result.totalItems,
              estimatedBatches: result.estimatedBatches,
              repairableJournalEntries: result.repairableJournalEntries,
              counts: result.counts,
            },
            stateFingerprint: result.stateFingerprint,
          }
        }
      }
    },

    async execute(request, progress) {
      await dependencies.assertBotStopped(dependencies.repositoryRoot)
      switch (request.operation) {
        case 'reset_state': {
          await progress({ phase: 'resetting', completed: 0, total: 1 })
          const result = await dependencies.resetAgentState({
            scope: request.scope,
            workspaceDir: dependencies.workspaceRoot,
            ...(request.scope === 'knowledge' ? {} : { db: dependencies.db }),
          })
          return { operation: 'reset_state', ...result }
        }
        case 'migrate_memory_v2': {
          await progress({ phase: 'migrating_memory', completed: 0, total: 1 })
          const result = await dependencies.migrateMemoryToV2({
            rootDir: dependencies.workspaceRoot,
            apply: true,
            loadSourceEvidence: dependencies.loadMemoryEvidence,
          })
          return {
            operation: 'migrate_memory_v2',
            backupDir: result.backupDir ?? null,
            filesBefore: result.filesBefore,
            filesAfter: result.filesAfter,
            entries: result.entries,
            movedPersonEntries: result.movedPersonEntries,
            quarantinedPersonEntries: result.quarantinedPersonEntries,
            warnings: result.warnings.length,
          }
        }
        case 'canonicalize_memory': {
          await progress({ phase: 'canonicalizing_memory', completed: 0, total: 1 })
          const result = await dependencies.canonicalizeSelfTopicMemory({
            rootDir: dependencies.workspaceRoot,
            apply: true,
          })
          return {
            operation: 'canonicalize_memory',
            backupDir: result.backupDir ?? null,
            filesBefore: result.filesBefore,
            filesAfter: result.filesAfter,
            entries: result.entries,
            consolidatedFiles: result.consolidatedFiles,
          }
        }
        case 'migrate_state_language': {
          const result = await dependencies.migrateLongTermStateToChinese({
            rootDir: dependencies.workspaceRoot,
            async translate(items) {
              const translate = await dependencies.createLanguageTranslator()
              let progressWrites = Promise.resolve()
              const translations = await translate(items, batch => {
                progressWrites = progressWrites.then(() => progress({
                  phase: 'translating',
                  completed: batch.completedBatches,
                  total: batch.totalBatches,
                }))
              })
              await progressWrites
              return translations
            },
          })
          return {
            operation: 'migrate_state_language',
            backupDir: result.backupDir,
            repairedNestedJournalEntries: result.repairedNestedJournalEntries,
            translated: result.translated,
            renamedMemoryFiles: result.renamedMemoryFiles.length,
            translatedItems: result.translatedItems,
          }
        }
      }
    },
  }
}

interface OperationsRuntime {
  port: AdminOperationsPort
  service: ReturnType<typeof createAdminOperationsService>
  runner: Awaited<ReturnType<typeof createOperationRunner>>
}

let runtimePromise: Promise<OperationsRuntime> | null = null

export async function loadOperationsSnapshot(): Promise<OperationsSnapshot> {
  return withPublicOperationError('snapshot', async () => {
    const runtime = await getOperationsRuntime()
    const [bot, state] = await Promise.all([
      runtime.port.inspectBot(),
      Promise.resolve(runtime.runner.snapshot()),
    ])
    return operationsSnapshotSchema.parse({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      bot,
      activeRun: state.activeRun,
      recentRuns: state.recentRuns,
    })
  })
}

export async function createOperationPreviewServer(request: OperationRequest): Promise<OperationPreview> {
  return withPublicOperationError('preview', async () => (
    (await getOperationsRuntime()).service.createPreview(request)
  ))
}

export async function startOperationServer(inputValue: unknown): Promise<OperationRun> {
  return withPublicOperationError('start', async () => {
    const runtime = await getOperationsRuntime()
    return startOperationWithRuntime(inputValue, {
      preflight: input => runtime.service.preflight(input),
      submit: input => runtime.runner.submit(input),
    })
  })
}

export async function startOperationWithRuntime(
  inputValue: unknown,
  runtime: {
    preflight(input: ReturnType<typeof operationStartRequestSchema.parse>): Promise<OperationPreview>
    submit(input: OperationRunStart): Promise<OperationRun>
  },
): Promise<OperationRun> {
  const input = operationStartRequestSchema.parse(inputValue)
  const preview = await runtime.preflight(input)
  return runtime.submit({
    request: preview.request,
    previewFingerprint: preview.fingerprint,
    previewId: preview.id,
    confirmation: input.confirmation,
  })
}

export async function getOperationRunServer(inputValue: unknown): Promise<OperationRun> {
  return withPublicOperationError('run_query', async () => {
    const input = operationRunIdRequestSchema.parse(inputValue)
    const run = (await getOperationsRuntime()).runner.find(input.runId)
    if (!run) throw Object.assign(new Error('operation_run_not_found'), { code: 'operation_run_not_found' })
    return run
  })
}

async function getOperationsRuntime(): Promise<OperationsRuntime> {
  runtimePromise ??= createDefaultOperationsRuntime()
  return runtimePromise
}

async function createDefaultOperationsRuntime(): Promise<OperationsRuntime> {
  const repositoryRoot = getRepositoryRoot()
  const workspaceRoot = getWorkspaceRoot()
  const db = getAdminPrisma() as unknown as AdminOperationsDb
  const port = createAdminOperationsPort({
    repositoryRoot,
    workspaceRoot,
    db,
    loadMemoryEvidence: ids => loadMemoryEvidence(db, ids),
    inspectBot: async root => botProcessStatusSchema.parse(await inspectBotProcessGuard(root)),
    assertBotStopped,
    previewAgentStateReset,
    resetAgentState,
    migrateMemoryToV2,
    canonicalizeSelfTopicMemory,
    planLongTermStateLanguageMigration,
    async createLanguageTranslator() {
      const { createLlmClient } = await import('../../../../../src/agent/llm-client.js')
      return createLongTermStateTranslator(createLlmClient())
    },
    migrateLongTermStateToChinese,
  })
  const service = createAdminOperationsService(port, {
    now: () => new Date(),
    id: randomUUID,
    hash: value => createHash('sha256').update(value).digest('hex'),
    previewTtlMs: 5 * 60_000,
  })
  const runner = await createOperationRunner({
    store: createOperationRunFileStore({
      repositoryRoot,
      currentPid: process.pid,
      now: () => new Date(),
      id: randomUUID,
    }),
    currentPid: process.pid,
    now: () => new Date(),
    id: randomUUID,
    execute: (input, progress) => service.execute({
      previewId: input.previewId,
      confirmation: input.confirmation,
    }, progress),
    reportError: report => reportAdminOperationError('runner', report.error, {
      phase: report.phase,
      runId: report.runId,
      operation: report.request.operation,
    }),
  })
  return { port, service, runner }
}

async function loadMemoryEvidence(
  db: AdminOperationsDb,
  ids: readonly number[],
): Promise<MemoryEvidenceRow[]> {
  if (ids.length === 0) return []
  const message = (db as unknown as {
    message: { findMany(input: object): Promise<Array<{
      id: number
      sceneKind: string
      sceneExternalId: string
      groupId: bigint | null
      messageId: bigint
      senderId: bigint
      sentAt: Date | null
      createdAt: Date
    }>> }
  }).message
  const rows = await message.findMany({
    where: { id: { in: [...new Set(ids)] } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      sceneKind: true,
      sceneExternalId: true,
      groupId: true,
      messageId: true,
      senderId: true,
      sentAt: true,
      createdAt: true,
    },
  })
  return rows.map(row => ({
    rowId: row.id,
    sceneKind: row.sceneKind as 'qq_group' | 'qq_private',
    sceneExternalId: row.sceneExternalId,
    groupId: row.groupId === null ? null : Number(row.groupId),
    messageId: String(row.messageId),
    senderId: String(row.senderId),
    sentAt: (row.sentAt ?? row.createdAt).toISOString(),
  }))
}

function hashState(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

async function withPublicOperationError<T>(stage: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    await reportAdminOperationError(stage, error)
    throw sanitizeOperationServerError(error)
  }
}

export function sanitizeOperationServerError(error: unknown): Error & { code: string } {
  const rawCode = error instanceof AdminOperationError
    ? error.code
    : error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'operation_request_failed'
  const code = PUBLIC_SERVER_ERROR_MESSAGES[rawCode] ? rawCode : 'operation_request_failed'
  return Object.assign(new Error(`${code}: ${PUBLIC_SERVER_ERROR_MESSAGES[code]!}`), { code })
}

const PUBLIC_SERVER_ERROR_MESSAGES: Record<string, string> = {
  preview_not_found: 'Preview is unavailable. Create a new preview.',
  confirmation_mismatch: 'Confirmation phrase did not match.',
  preview_expired: 'Preview expired. Create a new preview.',
  bot_running: 'Bot is running and must be stopped manually.',
  preview_stale: 'Operation inputs changed. Create a new preview.',
  operation_not_needed: 'The operation no longer has changes to apply.',
  operation_mismatch: 'Operation preview did not match the requested operation.',
  operation_in_progress: 'Another management operation is already active.',
  operation_run_not_found: 'Operation run was not found.',
  operation_state_corrupt: 'Persisted operation state is invalid.',
  operation_request_failed: 'Management operation request failed. Inspect the local WebAdmin app log.',
}

async function reportAdminOperationError(
  stage: string,
  error: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { createLogger } = await import('../../../../../src/logger.js')
    createLogger('ADMIN_OPERATIONS').error({
      stage,
      ...context,
      error: diagnosticError(error),
    }, 'WebAdmin management operation error')
  } catch {
    // Error reporting must not replace the original operation outcome.
  }
}

function diagnosticError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: redactOperationDiagnostic(String(error)).slice(0, 4_000) }
  const record = error as Error & { code?: unknown; backupDir?: unknown }
  return {
    name: error.name,
    message: redactOperationDiagnostic(error.message).slice(0, 4_000),
    stack: error.stack ? redactOperationDiagnostic(error.stack).slice(0, 8_000) : undefined,
    code: typeof record.code === 'string' ? record.code.slice(0, 100) : undefined,
    backupDir: typeof record.backupDir === 'string' ? record.backupDir.slice(0, 500) : undefined,
  }
}

export function redactOperationDiagnostic(value: string): string {
  return value
    .replace(/(Authorization\s*:\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|token|password|secret)["']?\s*[=:]\s*["'])[^"']*(["'])/gi, '$1[REDACTED]$2')
    .replace(/(["']?(?:api[_-]?key|token|password|secret)["']?\s*[=:]\s*)[^\s,;}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/gi, match => (
      `${match.slice(0, match.indexOf('://') + 3)}[REDACTED]`
    ))
}
