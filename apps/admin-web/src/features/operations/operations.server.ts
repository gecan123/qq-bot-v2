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
import { createOperationRunner } from './operation-runner.js'
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
            operation: 'reset_state',
            scope: request.scope,
            needed: contextNeeded || knowledgeNeeded,
            context: result.context ?? null,
            knowledge: result.knowledge ?? null,
          }
        }
        case 'migrate_memory_v2': {
          const result = await dependencies.migrateMemoryToV2({
            rootDir: dependencies.workspaceRoot,
            loadSourceEvidence: dependencies.loadMemoryEvidence,
          })
          return {
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
          }
        }
        case 'canonicalize_memory': {
          const result = await dependencies.canonicalizeSelfTopicMemory({
            rootDir: dependencies.workspaceRoot,
          })
          const sourceFiles = [...result.sourceFiles].sort()
          const targetFiles = [...result.targets].sort()
          return {
            operation: 'canonicalize_memory',
            needed: sourceFiles.length !== targetFiles.length
              || sourceFiles.some((file, index) => file !== targetFiles[index]),
            filesBefore: result.filesBefore,
            filesAfter: result.filesAfter,
            entries: result.entries,
            consolidatedFiles: result.consolidatedFiles,
            sourceFiles,
            targetFiles,
          }
        }
        case 'migrate_state_language': {
          const result = await dependencies.planLongTermStateLanguageMigration({
            rootDir: dependencies.workspaceRoot,
          })
          return {
            operation: 'migrate_state_language',
            needed: result.totalItems > 0,
            totalItems: result.totalItems,
            estimatedBatches: result.estimatedBatches,
            counts: result.counts,
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
          await progress({ phase: 'resetting', completed: 1, total: 1 })
          return { operation: 'reset_state', ...result }
        }
        case 'migrate_memory_v2': {
          await progress({ phase: 'migrating_memory', completed: 0, total: 1 })
          const result = await dependencies.migrateMemoryToV2({
            rootDir: dependencies.workspaceRoot,
            apply: true,
            loadSourceEvidence: dependencies.loadMemoryEvidence,
          })
          await progress({ phase: 'migrating_memory', completed: 1, total: 1 })
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
          await progress({ phase: 'canonicalizing_memory', completed: 1, total: 1 })
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
          const translate = await dependencies.createLanguageTranslator()
          const result = await dependencies.migrateLongTermStateToChinese({
            rootDir: dependencies.workspaceRoot,
            async translate(items) {
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
}

export async function createOperationPreviewServer(request: OperationRequest): Promise<OperationPreview> {
  return (await getOperationsRuntime()).service.createPreview(request)
}

export async function startOperationServer(inputValue: unknown): Promise<OperationRun> {
  const input = operationStartRequestSchema.parse(inputValue)
  const runtime = await getOperationsRuntime()
  const preview = runtime.service.getPreview(input.previewId)
  if (!preview) throw Object.assign(new Error('preview_not_found'), { code: 'preview_not_found' })
  return runtime.runner.submit({
    request: preview.request,
    previewFingerprint: preview.fingerprint,
    previewId: preview.id,
    confirmation: input.confirmation,
  })
}

export async function getOperationRunServer(inputValue: unknown): Promise<OperationRun> {
  const input = operationRunIdRequestSchema.parse(inputValue)
  const run = (await getOperationsRuntime()).runner.find(input.runId)
  if (!run) throw Object.assign(new Error('operation_run_not_found'), { code: 'operation_run_not_found' })
  return run
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
