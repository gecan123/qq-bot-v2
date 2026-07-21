import { z } from 'zod'

const isoDateSchema = z.iso.datetime({ offset: true })
const safePathSchema = z.string().min(1).max(500)
const operationIdSchema = z.string().min(1).max(100)

export const operationRequestSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('reset_state'),
    scope: z.enum(['context', 'knowledge', 'all']),
  }).strict(),
  z.object({ operation: z.literal('migrate_memory_v2') }).strict(),
  z.object({ operation: z.literal('canonicalize_memory') }).strict(),
  z.object({ operation: z.literal('migrate_state_language') }).strict(),
])

export const botProcessStatusSchema = z.discriminatedUnion('stopped', [
  z.object({
    stopped: z.literal(true),
    pid: z.null(),
    reason: z.literal('no_process'),
  }).strict(),
  z.object({
    stopped: z.literal(false),
    pid: z.number().int().positive(),
    reason: z.enum(['pidfile_live', 'process_scan_match']),
  }).strict(),
])

const resetContextSchema = z.object({
  ledgerEntries: z.number().int().nonnegative(),
  checkpoints: z.number().int().nonnegative(),
  runtimeStates: z.number().int().nonnegative(),
  goals: z.number().int().nonnegative(),
}).strict()

const resetKnowledgeSchema = z.object({
  directories: z.array(z.object({
    name: z.enum(['memory', 'journal', 'life', 'notebook']),
    exists: z.boolean(),
    files: z.number().int().nonnegative(),
  }).strict()).length(4),
}).strict()

const languageCountsSchema = z.object({
  memoryTitles: z.number().int().nonnegative(),
  memoryEntries: z.number().int().nonnegative(),
  notebookTopics: z.number().int().nonnegative(),
  notebookEntries: z.number().int().nonnegative(),
  lifeJournalEntries: z.number().int().nonnegative(),
  agendaItems: z.number().int().nonnegative(),
}).strict()

export const operationPreviewPayloadSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('reset_state'),
    scope: z.enum(['context', 'knowledge', 'all']),
    needed: z.boolean(),
    context: resetContextSchema.nullable(),
    knowledge: resetKnowledgeSchema.nullable(),
  }).strict(),
  z.object({
    operation: z.literal('migrate_memory_v2'),
    needed: z.boolean(),
    filesBefore: z.number().int().nonnegative(),
    filesAfter: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    movedPersonEntries: z.number().int().nonnegative(),
    quarantinedPersonEntries: z.number().int().nonnegative(),
    changes: z.array(z.object({
      from: safePathSchema,
      to: safePathSchema,
      entryId: z.string().min(1).max(200),
      reason: z.enum(['format_upgrade', 'person_quarantine', 'person_extracted_from_group']),
    }).strict()).max(50),
    warnings: z.array(z.string().max(500)).max(20),
    truncated: z.object({
      changes: z.number().int().nonnegative(),
      warnings: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('canonicalize_memory'),
    needed: z.boolean(),
    filesBefore: z.number().int().nonnegative(),
    filesAfter: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    consolidatedFiles: z.number().int().nonnegative(),
    sourceFiles: z.array(safePathSchema).max(100),
    targetFiles: z.array(safePathSchema).max(2),
  }).strict(),
  z.object({
    operation: z.literal('migrate_state_language'),
    needed: z.boolean(),
    totalItems: z.number().int().nonnegative(),
    estimatedBatches: z.number().int().nonnegative(),
    counts: languageCountsSchema,
  }).strict(),
])

export const operationResultPayloadSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('reset_state'),
    scope: z.enum(['context', 'knowledge', 'all']),
    deletedLedgerEntries: z.number().int().nonnegative(),
    deletedCheckpoints: z.number().int().nonnegative(),
    deletedRuntimeStates: z.number().int().nonnegative(),
    deletedGoals: z.number().int().nonnegative(),
    createdRuntimeState: z.boolean(),
    removedDirectories: z.array(z.enum(['memory', 'journal', 'life', 'notebook'])).max(4),
  }).strict(),
  z.object({
    operation: z.literal('migrate_memory_v2'),
    backupDir: safePathSchema.nullable(),
    filesBefore: z.number().int().nonnegative(),
    filesAfter: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    movedPersonEntries: z.number().int().nonnegative(),
    quarantinedPersonEntries: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    operation: z.literal('canonicalize_memory'),
    backupDir: safePathSchema.nullable(),
    filesBefore: z.number().int().nonnegative(),
    filesAfter: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    consolidatedFiles: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    operation: z.literal('migrate_state_language'),
    backupDir: safePathSchema,
    repairedNestedJournalEntries: z.number().int().nonnegative(),
    translated: languageCountsSchema,
    renamedMemoryFiles: z.number().int().nonnegative(),
    translatedItems: z.number().int().nonnegative(),
  }).strict(),
])

export const operationPreviewSchema = z.object({
  schemaVersion: z.literal(1),
  id: operationIdSchema,
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  request: operationRequestSchema,
  bot: botProcessStatusSchema,
  confirmationPhrase: z.string().min(1).max(200),
  payload: operationPreviewPayloadSchema,
}).strict()

export const operationStartRequestSchema = z.object({
  previewId: operationIdSchema,
  confirmation: z.string().max(200),
}).strict()

export const operationProgressSchema = z.object({
  phase: z.string().min(1).max(80),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict()

export const operationSafeErrorSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(500),
}).strict()

export const operationRunSchema = z.object({
  schemaVersion: z.literal(1),
  id: operationIdSchema,
  writerPid: z.number().int().positive(),
  request: operationRequestSchema,
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted']),
  createdAt: isoDateSchema,
  startedAt: isoDateSchema.nullable(),
  finishedAt: isoDateSchema.nullable(),
  progress: operationProgressSchema.nullable(),
  result: operationResultPayloadSchema.nullable(),
  error: operationSafeErrorSchema.nullable(),
}).strict()

export const operationRunStateSchema = z.object({
  version: z.literal(1),
  writerPid: z.number().int().positive(),
  updatedAt: isoDateSchema,
  activeRun: operationRunSchema.nullable(),
  recentRuns: z.array(operationRunSchema).max(25),
}).strict()

export const operationsSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: isoDateSchema,
  bot: botProcessStatusSchema,
  activeRun: operationRunSchema.nullable(),
  recentRuns: z.array(operationRunSchema).max(25),
}).strict()

export const operationRunIdRequestSchema = z.object({ runId: operationIdSchema }).strict()

export type OperationRequest = z.infer<typeof operationRequestSchema>
export type BotProcessStatusDto = z.infer<typeof botProcessStatusSchema>
export type OperationPreviewPayload = z.infer<typeof operationPreviewPayloadSchema>
export type OperationResultPayload = z.infer<typeof operationResultPayloadSchema>
export type OperationPreview = z.infer<typeof operationPreviewSchema>
export type OperationStartRequest = z.infer<typeof operationStartRequestSchema>
export type OperationProgress = z.infer<typeof operationProgressSchema>
export type OperationSafeError = z.infer<typeof operationSafeErrorSchema>
export type OperationRun = z.infer<typeof operationRunSchema>
export type OperationRunState = z.infer<typeof operationRunStateSchema>
export type OperationsSnapshot = z.infer<typeof operationsSnapshotSchema>
