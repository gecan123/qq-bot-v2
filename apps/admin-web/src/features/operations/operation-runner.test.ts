import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  createOperationRunner,
  type OperationRunStart,
  type OperationRunStore,
} from './operation-runner.js'
import type { OperationRunState, OperationResultPayload } from './operations.schema.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function startInput(id = 'preview-a'): OperationRunStart {
  return {
    request: { operation: 'reset_state', scope: 'context' },
    previewFingerprint: 'a'.repeat(64),
    previewId: id,
    confirmation: 'RESET context',
  }
}

function successResult(): OperationResultPayload {
  return {
    operation: 'reset_state',
    scope: 'context',
    deletedLedgerEntries: 1,
    deletedCheckpoints: 1,
    deletedRuntimeStates: 1,
    deletedGoals: 0,
    createdRuntimeState: true,
    removedDirectories: [],
  }
}

function memoryStore(initial?: OperationRunState): OperationRunStore & { writes: OperationRunState[] } {
  const writes: OperationRunState[] = []
  return {
    writes,
    async load() {
      return initial ?? {
        version: 1,
        writerPid: 10,
        updatedAt: '2026-07-21T10:00:00.000Z',
        activeRun: null,
        recentRuns: [],
      }
    },
    async persist(state) {
      writes.push(structuredClone(state))
    },
  }
}

describe('createOperationRunner', () => {
  test('allows only one active operation and resolves the first run as succeeded', async () => {
    const gate = deferred<OperationResultPayload>()
    const runner = await createOperationRunner({
      store: memoryStore(),
      currentPid: 10,
      now: () => new Date('2026-07-21T10:00:00.000Z'),
      id: () => 'run-1',
      execute: async () => gate.promise,
    })

    const first = runner.start(startInput())
    await assert.rejects(runner.start(startInput('preview-b')), /operation_in_progress/)
    gate.resolve(successResult())

    assert.equal((await first).status, 'succeeded')
    assert.equal(runner.snapshot().activeRun, null)
    assert.equal(runner.snapshot().recentRuns[0]?.status, 'succeeded')
  })

  test('persists validated progress and exposes it while a run is active', async () => {
    const gate = deferred<OperationResultPayload>()
    const store = memoryStore()
    const runner = await createOperationRunner({
      store,
      currentPid: 10,
      now: () => new Date('2026-07-21T10:00:00.000Z'),
      id: () => 'run-progress',
      execute: async (_input, report) => {
        await report({ phase: 'translating', completed: 1, total: 3 })
        return gate.promise
      },
    })

    const completion = runner.start(startInput())
    await waitFor(() => runner.snapshot().activeRun?.progress?.completed === 1)

    assert.deepEqual(runner.snapshot().activeRun?.progress, {
      phase: 'translating',
      completed: 1,
      total: 3,
    })
    assert.equal(store.writes.some(state => state.activeRun?.progress?.completed === 1), true)
    gate.resolve(successResult())
    await completion
  })

  test('converges executor failures into a bounded safe error', async () => {
    const runner = await createOperationRunner({
      store: memoryStore(),
      currentPid: 10,
      now: () => new Date('2026-07-21T10:00:00.000Z'),
      id: () => 'run-failed',
      execute: async () => { throw Object.assign(new Error(`secret:${'x'.repeat(800)}`), { code: 'database_failed' }) },
    })

    const run = await runner.start(startInput())

    assert.equal(run.status, 'failed')
    assert.equal(run.error?.code, 'database_failed')
    assert.equal(run.error?.message.length, 500)
    assert.equal(run.result, null)
  })

  test('restores a running record from another writer as interrupted', async () => {
    const initial: OperationRunState = {
      version: 1,
      writerPid: 11,
      updatedAt: '2026-07-21T09:59:00.000Z',
      activeRun: {
        schemaVersion: 1,
        id: 'old-run',
        writerPid: 11,
        request: { operation: 'canonicalize_memory' },
        previewFingerprint: 'b'.repeat(64),
        status: 'running',
        createdAt: '2026-07-21T09:58:00.000Z',
        startedAt: '2026-07-21T09:58:01.000Z',
        finishedAt: null,
        progress: null,
        result: null,
        error: null,
      },
      recentRuns: [],
    }
    const store = memoryStore(initial)

    const runner = await createOperationRunner({
      store,
      currentPid: 22,
      now: () => new Date('2026-07-21T10:00:00.000Z'),
      id: () => 'new-run',
      execute: async () => successResult(),
    })

    assert.equal(runner.snapshot().activeRun, null)
    assert.equal(runner.snapshot().recentRuns[0]?.status, 'interrupted')
    assert.equal(runner.snapshot().recentRuns[0]?.error?.code, 'process_interrupted')
    assert.equal(store.writes.length, 1)
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition not reached')
}
