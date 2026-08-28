import { z } from 'zod'

const isoDateSchema = z.iso.datetime({ offset: true })
const operationIdSchema = z.string().min(1).max(100)
const resetScopeSchema = z.enum(['context', 'knowledge', 'all'])

export const operationRequestSchema = z.object({
  operation: z.literal('reset_state'),
  scope: resetScopeSchema,
}).strict()

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
}).strict()

const resetKnowledgeSchema = z.object({
  directories: z.array(z.object({
    name: z.enum(['memory', 'notebook']),
    exists: z.boolean(),
    files: z.number().int().nonnegative(),
  }).strict()).length(2),
}).strict()

const resetWorkspaceSchema = z.object({
  preservedFiles: z.tuple([z.literal('.gitignore'), z.literal('README.md')]),
  entries: z.array(z.object({
    name: z.string().min(1).max(500),
    kind: z.enum(['directory', 'file', 'symlink', 'other']),
    files: z.number().int().nonnegative(),
  }).strict()).max(100),
}).strict()

export const operationPreviewPayloadSchema = z.object({
  operation: z.literal('reset_state'),
  scope: resetScopeSchema,
  needed: z.boolean(),
  context: resetContextSchema.nullable(),
  knowledge: resetKnowledgeSchema.nullable(),
  workspace: resetWorkspaceSchema.nullable(),
}).strict()

export const operationResultPayloadSchema = z.object({
  operation: z.literal('reset_state'),
  scope: resetScopeSchema,
  deletedLedgerEntries: z.number().int().nonnegative(),
  deletedCheckpoints: z.number().int().nonnegative(),
  deletedRuntimeStates: z.number().int().nonnegative(),
  createdRuntimeState: z.boolean(),
  removedDirectories: z.array(z.enum(['memory', 'notebook'])).max(2),
  removedWorkspaceEntries: z.number().int().nonnegative().default(0),
}).strict()

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
}).strict().superRefine((run, context) => {
  const active = run.status === 'queued' || run.status === 'running'
  if (active && run.finishedAt !== null) {
    context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'active run cannot be finished' })
  }
  if (!active && run.finishedAt === null) {
    context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'terminal run must be finished' })
  }
  if (run.status === 'queued' && run.startedAt !== null) {
    context.addIssue({ code: 'custom', path: ['startedAt'], message: 'queued run cannot be started' })
  }
  if (run.status === 'running' && run.startedAt === null) {
    context.addIssue({ code: 'custom', path: ['startedAt'], message: 'running run must be started' })
  }
  if ((run.status === 'succeeded' || run.status === 'failed') && run.startedAt === null) {
    context.addIssue({ code: 'custom', path: ['startedAt'], message: 'completed run must have started' })
  }
  if (run.status === 'queued' && run.progress !== null) {
    context.addIssue({ code: 'custom', path: ['progress'], message: 'queued run cannot have progress' })
  }
  if (run.status === 'succeeded') {
    if (run.result === null) context.addIssue({ code: 'custom', path: ['result'], message: 'succeeded run requires a result' })
    if (run.error !== null) context.addIssue({ code: 'custom', path: ['error'], message: 'succeeded run cannot have an error' })
  } else if (run.result !== null) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'non-succeeded run cannot have a result' })
  }
  if ((run.status === 'failed' || run.status === 'interrupted') && run.error === null) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'failed or interrupted run requires an error' })
  }
  if (active && run.error !== null) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'active run cannot have an error' })
  }
  if (run.result && run.result.scope !== run.request.scope) {
    context.addIssue({ code: 'custom', path: ['result', 'scope'], message: 'reset result scope must match request' })
  }
})

export const operationRunStateSchema = z.object({
  version: z.literal(1),
  writerPid: z.number().int().positive(),
  updatedAt: isoDateSchema,
  activeRun: operationRunSchema.nullable(),
  recentRuns: z.array(operationRunSchema).max(25),
}).strict().superRefine((state, context) => {
  if (state.activeRun && state.activeRun.status !== 'queued' && state.activeRun.status !== 'running') {
    context.addIssue({ code: 'custom', path: ['activeRun', 'status'], message: 'active run must be queued or running' })
  }
  state.recentRuns.forEach((run, index) => {
    if (run.status === 'queued' || run.status === 'running') {
      context.addIssue({ code: 'custom', path: ['recentRuns', index, 'status'], message: 'recent run must be terminal' })
    }
  })
  const ids = [state.activeRun?.id, ...state.recentRuns.map(run => run.id)].filter(Boolean)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['recentRuns'], message: 'run ids must be unique' })
  }
})

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
