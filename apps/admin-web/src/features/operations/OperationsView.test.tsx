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
    context: { ledgerEntries: 7, checkpoints: 1, runtimeStates: 1 },
    knowledge: null,
    workspace: null,
  },
}

afterEach(cleanup)

describe('OperationsView', () => {
  test('shows only reset state without command or path inputs', () => {
    renderView()

    assert.ok(screen.getByText('重置 Agent 状态'))
    assert.equal(screen.queryByText('迁移 Memory V2'), null)
    assert.equal(screen.queryByText('归并 Memory 文件'), null)
    assert.equal(screen.queryByText('迁移长期状态语言'), null)
    assert.equal(screen.queryByLabelText(/命令|command|路径|path/i), null)
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

  test('invalidates an old preview when the reset scope changes', () => {
    renderView({ preview: resetPreview })
    const execute = screen.getByRole('button', { name: '执行操作' }) as HTMLButtonElement
    const confirmation = screen.getByLabelText('确认短语')

    fireEvent.change(confirmation, { target: { value: 'RESET context' } })
    assert.equal(execute.disabled, false)

    fireEvent.change(screen.getByLabelText('重置范围'), { target: { value: 'all' } })
    assert.equal(execute.disabled, true)
    assert.ok(screen.getByText(/当前范围已变化，请重新生成预览/))
  })

  test('asks for a new preview after stale-preview rejection', () => {
    renderView({ preview: resetPreview, error: 'preview_stale: operation inputs changed' })

    assert.ok(screen.getByText(/预览已过期或状态已变化，请重新生成预览/))
  })

  test('renders running progress and distinct terminal outcomes', () => {
    const { rerender } = renderView({ run: operationRun('running') })
    assert.ok(screen.getByText('正在执行'))
    assert.ok(screen.getByText('0 / 1'))

    rerender(view({ run: operationRun('succeeded') }))
    assert.ok(screen.getByText('执行成功'))
    assert.ok(screen.getByText(/结果已通过 schema 校验/))

    rerender(view({ run: operationRun('failed') }))
    assert.ok(screen.getByText('执行失败'))
    assert.ok(screen.getByText('reset failed safely'))

    rerender(view({ run: operationRun('interrupted') }))
    assert.ok(screen.getByText('执行被中断'))
    assert.ok(screen.getByText(/检查当前状态后再决定是否重试/))
  })
})

function operationRun(status: OperationRun['status']): OperationRun {
  return {
    schemaVersion: 1,
    id: `run-${status}`,
    writerPid: 42,
    request: { operation: 'reset_state', scope: 'all' },
    previewFingerprint: 'b'.repeat(64),
    status,
    createdAt: '2026-07-21T10:00:00.000Z',
    startedAt: status === 'queued' ? null : '2026-07-21T10:00:01.000Z',
    finishedAt: ['succeeded', 'failed', 'interrupted'].includes(status)
      ? '2026-07-21T10:00:03.000Z'
      : null,
    progress: status === 'running' ? { phase: 'resetting', completed: 0, total: 1 } : null,
    result: status === 'succeeded' ? {
      operation: 'reset_state',
      scope: 'all',
      deletedLedgerEntries: 7,
      deletedCheckpoints: 1,
      deletedRuntimeStates: 1,
      createdRuntimeState: true,
      removedDirectories: ['memory', 'notebook'],
      removedWorkspaceEntries: 3,
    } : null,
    error: status === 'failed'
      ? { code: 'operation_failed', message: 'reset failed safely' }
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
