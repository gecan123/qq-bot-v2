import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, test } from 'vitest'
import type {
  OperationPreview,
  OperationRun,
  OperationsSnapshot,
} from './operations.schema.js'
import { OperationsView } from './OperationsView.js'

const snapshot: OperationsSnapshot = {
  schemaVersion: 1,
  generatedAt: '2026-07-21T10:00:00.000Z',
  bot: { stopped: true, pid: null, reason: 'no_process' },
  activeRun: null,
  recentRuns: [],
}

const resetPreview: OperationPreview = {
  schemaVersion: 1,
  id: 'preview-reset',
  createdAt: '2026-07-21T10:00:00.000Z',
  expiresAt: '2099-07-21T10:05:00.000Z',
  fingerprint: 'a'.repeat(64),
  request: { operation: 'reset_state', scope: 'context' },
  bot: { stopped: true, pid: null, reason: 'no_process' },
  confirmationPhrase: 'RESET context',
  payload: {
    operation: 'reset_state',
    scope: 'context',
    needed: true,
    context: { ledgerEntries: 7, checkpoints: 1, runtimeStates: 1, goals: 1 },
    knowledge: null,
  },
}

const noOpMemoryPreview: OperationPreview = {
  ...resetPreview,
  id: 'preview-memory',
  request: { operation: 'migrate_memory_v2' },
  confirmationPhrase: 'MIGRATE MEMORY V2',
  payload: {
    operation: 'migrate_memory_v2',
    needed: false,
    filesBefore: 2,
    filesAfter: 2,
    entries: 3,
    movedPersonEntries: 0,
    quarantinedPersonEntries: 0,
    changes: [],
    warnings: [],
    truncated: { changes: 0, warnings: 0 },
  },
}

afterEach(cleanup)

describe('OperationsView', () => {
  test('shows four fixed operation cards without command or path inputs', () => {
    renderView()

    assert.ok(screen.getByText('重置 Agent 状态'))
    assert.ok(screen.getByText('迁移 Memory V2'))
    assert.ok(screen.getByText('归并 Memory 文件'))
    assert.ok(screen.getByText('迁移长期状态语言'))
    assert.equal(screen.queryByLabelText(/命令|command|路径|path/i), null)
  })

  test('marks an unnecessary migration and disables execution', () => {
    renderView({ preview: noOpMemoryPreview })

    assert.ok(screen.getAllByText('无需执行').length >= 1)
    assert.equal((screen.getByRole('button', { name: '执行操作' }) as HTMLButtonElement).disabled, true)
  })

  test('shows a live Bot block reason and disables execution', () => {
    renderView({
      snapshot: {
        ...snapshot,
        bot: { stopped: false, pid: 42, reason: 'pidfile_live' },
      },
      preview: {
        ...resetPreview,
        bot: { stopped: false, pid: 42, reason: 'pidfile_live' },
      },
    })

    assert.ok(screen.getByText(/Bot 仍在运行.*PID 42/))
    assert.equal((screen.getByRole('button', { name: '执行操作' }) as HTMLButtonElement).disabled, true)
  })

  test('requires the exact reset phrase and displays the irreversible warning', () => {
    let submitted: unknown = null
    renderView({ preview: resetPreview, onExecute: input => { submitted = input } })

    assert.ok(screen.getByText(/没有自动恢复路径/))
    assert.ok(screen.getByText('RESET context'))
    const execute = screen.getByRole('button', { name: '执行操作' }) as HTMLButtonElement
    assert.equal(execute.disabled, true)
    fireEvent.change(screen.getByLabelText('确认短语'), { target: { value: 'RESET context' } })
    assert.equal(execute.disabled, false)
    fireEvent.click(execute)
    assert.deepEqual(submitted, { previewId: 'preview-reset', confirmation: 'RESET context' })
  })

  test('invalidates an old preview when the selected operation or reset scope changes', () => {
    renderView({ preview: resetPreview })
    const execute = screen.getByRole('button', { name: '执行操作' }) as HTMLButtonElement
    const confirmation = screen.getByLabelText('确认短语')

    fireEvent.change(confirmation, { target: { value: 'RESET context' } })
    assert.equal(execute.disabled, false)

    fireEvent.click(screen.getByRole('button', { name: /迁移 Memory V2/ }))
    assert.equal(execute.disabled, true)
    assert.ok(screen.getByText(/当前选择已变化，请重新生成预览/))

    fireEvent.click(screen.getByRole('button', { name: /重置 Agent 状态/ }))
    fireEvent.change(screen.getByLabelText('重置范围'), { target: { value: 'all' } })
    assert.equal(execute.disabled, true)
    assert.ok(screen.getByText(/当前选择已变化，请重新生成预览/))
  })

  test('asks for a new preview after stale-preview rejection', () => {
    renderView({ preview: resetPreview, error: 'preview_stale: operation inputs changed' })

    assert.ok(screen.getByText(/预览已过期或状态已变化，请重新生成预览/))
  })

  test('renders running progress and distinct terminal outcomes', () => {
    const { rerender } = renderView({ run: operationRun('running') })
    assert.ok(screen.getByText('正在执行'))
    assert.ok(screen.getByText('1 / 3'))

    rerender(view({ run: operationRun('succeeded') }))
    assert.ok(screen.getByText('执行成功'))
    assert.ok(screen.getByText('/repo/data/agent-workspace/db-backups/memory-v2'))

    rerender(view({ run: operationRun('failed') }))
    assert.ok(screen.getByText('执行失败'))
    assert.ok(screen.getByText('migration failed safely'))
    assert.ok(screen.getByText('/repo/data/agent-workspace/db-backups/failed-memory-v2'))

    rerender(view({ run: operationRun('interrupted') }))
    assert.ok(screen.getByText('执行被中断'))
    assert.ok(screen.getByText(/检查备份和当前状态后再决定是否重试/))
  })

  test('keeps a persisted backup path visible in recent history after reload', () => {
    renderView({
      snapshot: {
        ...snapshot,
        recentRuns: [operationRun('failed')],
      },
    })

    assert.ok(screen.getByText('/repo/data/agent-workspace/db-backups/failed-memory-v2'))
  })
})

function operationRun(status: OperationRun['status']): OperationRun {
  return {
    schemaVersion: 1,
    id: `run-${status}`,
    writerPid: 42,
    request: { operation: 'migrate_memory_v2' },
    previewFingerprint: 'b'.repeat(64),
    status,
    createdAt: '2026-07-21T10:00:00.000Z',
    startedAt: status === 'queued' ? null : '2026-07-21T10:00:01.000Z',
    finishedAt: ['succeeded', 'failed', 'interrupted'].includes(status)
      ? '2026-07-21T10:00:03.000Z'
      : null,
    progress: status === 'running' ? { phase: 'migrating_memory', completed: 1, total: 3 } : null,
    result: status === 'succeeded' ? {
      operation: 'migrate_memory_v2',
      backupDir: '/repo/data/agent-workspace/db-backups/memory-v2',
      filesBefore: 2,
      filesAfter: 3,
      entries: 4,
      movedPersonEntries: 1,
      quarantinedPersonEntries: 1,
      warnings: 0,
    } : null,
    error: status === 'failed'
      ? {
          code: 'migration_failed',
          message: 'migration failed safely',
          backupDir: '/repo/data/agent-workspace/db-backups/failed-memory-v2',
        }
      : status === 'interrupted'
        ? { code: 'process_interrupted', message: 'process exited' }
        : null,
  }
}

function view(overrides: Partial<Parameters<typeof OperationsView>[0]> = {}) {
  return <OperationsView
    snapshot={snapshot}
    preview={null}
    run={null}
    isRefreshing={false}
    isPreviewing={false}
    isStarting={false}
    error={null}
    onPreview={() => undefined}
    onExecute={() => undefined}
    {...overrides}
  />
}

function renderView(overrides: Partial<Parameters<typeof OperationsView>[0]> = {}) {
  return render(view(overrides))
}
