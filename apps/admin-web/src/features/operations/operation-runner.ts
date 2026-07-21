import {
  operationProgressSchema,
  operationResultPayloadSchema,
  operationRunSchema,
  operationRunStateSchema,
  type OperationProgress,
  type OperationRequest,
  type OperationResultPayload,
  type OperationRun,
  type OperationRunState,
  type OperationSafeError,
} from './operations.schema.js'

export interface OperationRunStart {
  request: OperationRequest
  previewFingerprint: string
  previewId: string
  confirmation: string
}

export interface OperationRunStore {
  load(): Promise<OperationRunState>
  persist(state: OperationRunState, transition: OperationRun): Promise<void>
}

export type OperationRunExecutor = (
  input: OperationRunStart,
  progress: (value: OperationProgress) => Promise<void>,
) => Promise<OperationResultPayload>

export interface OperationRunnerErrorReport {
  phase: 'execution' | 'terminal_persist' | 'failure_persist' | 'completion'
  runId: string
  request: OperationRequest
  error: unknown
}

export async function createOperationRunner(options: {
  store: OperationRunStore
  currentPid: number
  now(): Date
  id(): string
  execute: OperationRunExecutor
  reportError?(report: OperationRunnerErrorReport): void | Promise<void>
}): Promise<{
  start(input: OperationRunStart): Promise<OperationRun>
  submit(input: OperationRunStart): Promise<OperationRun>
  snapshot(): OperationRunState
  find(runId: string): OperationRun | null
}> {
  let state = operationRunStateSchema.parse(await options.store.load())
  if (
    state.activeRun
    && ['queued', 'running'].includes(state.activeRun.status)
    && state.activeRun.writerPid !== options.currentPid
  ) {
    const interrupted = operationRunSchema.parse({
      ...state.activeRun,
      status: 'interrupted',
      finishedAt: options.now().toISOString(),
      result: null,
      error: {
        code: 'process_interrupted',
        message: 'WebAdmin process exited before this operation reached a terminal state',
      },
    })
    state = nextCompletedState(state, interrupted, options.currentPid, options.now())
    await options.store.persist(state, interrupted)
  } else if (state.writerPid !== options.currentPid) {
    state = operationRunStateSchema.parse({
      ...state,
      writerPid: options.currentPid,
      updatedAt: options.now().toISOString(),
    })
  }

  function begin(input: OperationRunStart): {
    queued: Promise<OperationRun>
    completion: Promise<OperationRun>
    run: OperationRun
  } {
    if (state.activeRun) throw operationError('operation_in_progress', 'another operation is already active')
    const queuedRun = operationRunSchema.parse({
      schemaVersion: 1,
      id: options.id(),
      writerPid: options.currentPid,
      request: input.request,
      previewFingerprint: input.previewFingerprint,
      status: 'queued',
      createdAt: options.now().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      result: null,
      error: null,
    })
    state = activeState(state, queuedRun, options.currentPid, options.now())

    let queuedDone!: (run: OperationRun) => void
    let queuedFailed!: (error: unknown) => void
    const queued = new Promise<OperationRun>((resolve, reject) => {
      queuedDone = resolve
      queuedFailed = reject
    })
    const completion = (async () => {
      try {
        await options.store.persist(state, queuedRun)
        queuedDone(queuedRun)
        const running = operationRunSchema.parse({
          ...queuedRun,
          status: 'running',
          startedAt: options.now().toISOString(),
        })
        state = activeState(state, running, options.currentPid, options.now())
        await options.store.persist(state, running)

        const result = operationResultPayloadSchema.parse(await options.execute(input, async value => {
          const progress = operationProgressSchema.parse(value)
          const active = state.activeRun
          if (!active || active.id !== queuedRun.id || active.status !== 'running') return
          const progressed = operationRunSchema.parse({ ...active, progress })
          state = activeState(state, progressed, options.currentPid, options.now())
          await options.store.persist(state, progressed)
        }))
        const succeeded = operationRunSchema.parse({
          ...state.activeRun,
          status: 'succeeded',
          finishedAt: options.now().toISOString(),
          result,
          error: null,
        })
        state = nextCompletedState(state, succeeded, options.currentPid, options.now())
        try {
          await options.store.persist(state, succeeded)
        } catch (error) {
          await reportError('terminal_persist', queuedRun, error)
        }
        return succeeded
      } catch (error) {
        await reportError('execution', queuedRun, error)
        queuedFailed(error)
        const active = state.activeRun?.id === queuedRun.id ? state.activeRun : queuedRun
        const failed = operationRunSchema.parse({
          ...active,
          status: 'failed',
          startedAt: active.startedAt ?? options.now().toISOString(),
          finishedAt: options.now().toISOString(),
          result: null,
          error: safeError(error),
        })
        state = nextCompletedState(state, failed, options.currentPid, options.now())
        try {
          await options.store.persist(state, failed)
        } catch (persistError) {
          await reportError('failure_persist', queuedRun, persistError)
        }
        return failed
      }
    })()
    return { queued, completion, run: queuedRun }
  }

  return {
    async start(input) {
      const handle = begin(input)
      void handle.queued.catch(() => undefined)
      return handle.completion
    },
    async submit(input) {
      const handle = begin(input)
      void handle.completion.catch(error => reportError('completion', handle.run, error))
      return handle.queued
    },
    snapshot() {
      return structuredClone(state)
    },
    find(runId) {
      if (state.activeRun?.id === runId) return structuredClone(state.activeRun)
      const found = state.recentRuns.find(run => run.id === runId)
      return found ? structuredClone(found) : null
    },
  }

  async function reportError(
    phase: OperationRunnerErrorReport['phase'],
    run: OperationRun,
    error: unknown,
  ): Promise<void> {
    try {
      await options.reportError?.({ phase, runId: run.id, request: run.request, error })
    } catch {
      // Diagnostics must never change the operation outcome.
    }
  }
}

function activeState(
  previous: OperationRunState,
  activeRun: OperationRun,
  writerPid: number,
  now: Date,
): OperationRunState {
  return operationRunStateSchema.parse({
    ...previous,
    writerPid,
    updatedAt: now.toISOString(),
    activeRun,
  })
}

function nextCompletedState(
  previous: OperationRunState,
  completed: OperationRun,
  writerPid: number,
  now: Date,
): OperationRunState {
  return operationRunStateSchema.parse({
    version: 1,
    writerPid,
    updatedAt: now.toISOString(),
    activeRun: null,
    recentRuns: [completed, ...previous.recentRuns.filter(run => run.id !== completed.id)].slice(0, 25),
  })
}

function safeError(error: unknown): OperationSafeError {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const rawCode = typeof record.code === 'string' ? record.code : 'operation_failed'
  const code = PUBLIC_ERROR_CODES.has(rawCode) ? rawCode : 'operation_failed'
  const backupDir = typeof record.backupDir === 'string'
    && record.backupDir.length > 0
    && record.backupDir.length <= 500
    ? record.backupDir
    : undefined
  return {
    code,
    message: publicErrorMessage(code),
    ...(backupDir ? { backupDir } : {}),
  }
}

const PUBLIC_ERROR_CODES = new Set([
  'preview_not_found',
  'confirmation_mismatch',
  'preview_expired',
  'bot_running',
  'preview_stale',
  'operation_not_needed',
  'operation_mismatch',
  'operation_in_progress',
  'process_interrupted',
  'operation_state_corrupt',
])

function publicErrorMessage(code: string): string {
  switch (code) {
    case 'preview_not_found': return 'Preview is unavailable. Create a new preview.'
    case 'confirmation_mismatch': return 'Confirmation phrase did not match.'
    case 'preview_expired': return 'Preview expired. Create a new preview.'
    case 'bot_running': return 'Bot is running and must be stopped manually.'
    case 'preview_stale': return 'Operation inputs changed. Create a new preview.'
    case 'operation_not_needed': return 'The operation no longer has changes to apply.'
    case 'operation_in_progress': return 'Another management operation is already active.'
    case 'process_interrupted': return 'The WebAdmin process exited before the operation completed.'
    case 'operation_state_corrupt': return 'Persisted operation state is invalid.'
    default: return 'Operation failed. Inspect the local WebAdmin logs before retrying.'
  }
}

function operationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}
