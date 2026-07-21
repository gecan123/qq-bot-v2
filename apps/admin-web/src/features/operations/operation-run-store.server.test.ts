import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'vitest'
import { createOperationRunFileStore } from './operation-run-store.server.js'
import { operationRunStateSchema, type OperationRun, type OperationRunState } from './operations.schema.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function run(status: OperationRun['status']): OperationRun {
  return {
    schemaVersion: 1,
    id: 'run-1',
    writerPid: 42,
    request: { operation: 'migrate_state_language' },
    previewFingerprint: 'a'.repeat(64),
    status,
    createdAt: '2026-07-21T10:00:00.000Z',
    startedAt: status === 'queued' ? null : '2026-07-21T10:00:01.000Z',
    finishedAt: status === 'succeeded' ? '2026-07-21T10:00:02.000Z' : null,
    progress: status === 'running' ? { phase: 'translating', completed: 1, total: 2 } : null,
    result: status === 'succeeded' ? {
      operation: 'migrate_state_language',
      backupDir: '/repo/data/agent-workspace/db-backups/one',
      repairedNestedJournalEntries: 0,
      translated: {
        memoryTitles: 1,
        memoryEntries: 1,
        notebookTopics: 0,
        notebookEntries: 0,
        lifeJournalEntries: 0,
        agendaItems: 0,
      },
      renamedMemoryFiles: 1,
      translatedItems: 2,
    } : null,
    error: null,
  }
}

function state(activeRun: OperationRun | null, recentRuns: OperationRun[] = []): OperationRunState {
  return {
    version: 1,
    writerPid: 42,
    updatedAt: '2026-07-21T10:00:02.000Z',
    activeRun,
    recentRuns,
  }
}

describe('createOperationRunFileStore', () => {
  test('returns an empty state when the state file is missing', async () => {
    const repositoryRoot = await temporaryRepository()
    const store = createOperationRunFileStore({
      repositoryRoot,
      currentPid: 42,
      now: () => new Date('2026-07-21T10:00:00.000Z'),
      id: () => 'temp-1',
    })

    assert.deepEqual(await store.load(), {
      version: 1,
      writerPid: 42,
      updatedAt: '2026-07-21T10:00:00.000Z',
      activeRun: null,
      recentRuns: [],
    })
  })

  test('atomically replaces validated state and appends one compact audit line per transition', async () => {
    const repositoryRoot = await temporaryRepository()
    let tempId = 0
    const store = createOperationRunFileStore({
      repositoryRoot,
      currentPid: 42,
      now: () => new Date('2026-07-21T10:00:00.000Z'),
      id: () => `temp-${++tempId}`,
    })
    const queued = run('queued')
    const succeeded = run('succeeded')

    await store.persist(state(queued), queued)
    await store.persist(state(null, [succeeded]), succeeded)

    const persisted = operationRunStateSchema.parse(JSON.parse(
      await readFile(join(repositoryRoot, 'logs', 'admin-operation-state.json'), 'utf8'),
    ))
    assert.equal(persisted.recentRuns[0]?.status, 'succeeded')
    const auditRaw = await readFile(join(repositoryRoot, 'logs', 'admin-operations.ndjson'), 'utf8')
    const auditLines = auditRaw.trim().split('\n')
    assert.equal(auditLines.length, 2)
    for (const line of auditLines) assert.equal(line, JSON.stringify(JSON.parse(line)))
    assert.doesNotMatch(auditRaw, /previewBody|translation text|Migration notes/)
    assert.match(auditRaw, /previewFingerprint/)
  })

  test('fails closed when persisted state is corrupt', async () => {
    const repositoryRoot = await temporaryRepository()
    await writeFile(join(repositoryRoot, 'logs', 'admin-operation-state.json'), '{"version":999}', 'utf8')
    const store = createOperationRunFileStore({
      repositoryRoot,
      currentPid: 42,
      now: () => new Date('2026-07-21T10:00:00.000Z'),
      id: () => 'temp-1',
    })

    await assert.rejects(store.load(), /operation_state_corrupt/)
  })
})

async function temporaryRepository(): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'admin-operation-store-'))
  temporaryDirectories.push(repositoryRoot)
  await mkdir(join(repositoryRoot, 'logs'), { recursive: true })
  return repositoryRoot
}
