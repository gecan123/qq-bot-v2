import '@tanstack/react-start/server-only'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OperationRunStore } from './operation-runner.js'
import {
  operationRunSchema,
  operationRunStateSchema,
  type OperationRunState,
} from './operations.schema.js'

export function createOperationRunFileStore(options: {
  repositoryRoot: string
  currentPid: number
  now(): Date
  id(): string
}): OperationRunStore {
  const logsDir = join(options.repositoryRoot, 'logs')
  const statePath = join(logsDir, 'admin-operation-state.json')
  const auditPath = join(logsDir, 'admin-operations.ndjson')

  return {
    async load() {
      let raw: string
      try {
        raw = await readFile(statePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(options.currentPid, options.now())
        throw error
      }
      try {
        return operationRunStateSchema.parse(JSON.parse(raw))
      } catch (error) {
        throw Object.assign(new Error('operation_state_corrupt: persisted operation state is invalid'), {
          code: 'operation_state_corrupt',
          cause: error,
        })
      }
    },

    async persist(stateInput, transitionInput) {
      const state = operationRunStateSchema.parse(stateInput)
      const transition = operationRunSchema.parse(transitionInput)
      await mkdir(logsDir, { recursive: true })
      const temporaryPath = join(logsDir, `.admin-operation-state.${options.id()}.tmp`)
      try {
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        await rename(temporaryPath, statePath)
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
      }
      await appendFile(auditPath, `${JSON.stringify(auditEvent(state, transition))}\n`, 'utf8')
    },
  }
}

function emptyState(currentPid: number, now: Date): OperationRunState {
  return operationRunStateSchema.parse({
    version: 1,
    writerPid: currentPid,
    updatedAt: now.toISOString(),
    activeRun: null,
    recentRuns: [],
  })
}

function auditEvent(state: OperationRunState, run: ReturnType<typeof operationRunSchema.parse>) {
  return {
    schemaVersion: 1,
    runId: run.id,
    operation: run.request.operation,
    ...(run.request.operation === 'reset_state' ? { scope: run.request.scope } : {}),
    previewFingerprint: run.previewFingerprint,
    at: state.updatedAt,
    status: run.status,
    progress: run.progress,
    resultSummary: run.result,
    error: run.error,
  }
}
