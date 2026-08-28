import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'vitest'
import {
  createAdminOperationsPort,
  redactOperationDiagnostic,
  sanitizeOperationServerError,
  startOperationWithRuntime,
  type AdminOperationsAdapterDependencies,
} from './operations.server.js'
import { createAdminOperationsService } from './operations.service.js'

function dependencies(events: string[]): AdminOperationsAdapterDependencies {
  return {
    repositoryRoot: '/repo',
    workspaceRoot: '/repo/data/agent-workspace',
    db: {} as AdminOperationsAdapterDependencies['db'],
    async inspectBot() {
      events.push('inspect_bot')
      return { stopped: true, pid: null, reason: 'no_process' }
    },
    async assertBotStopped() { events.push('assert_bot_stopped') },
    async previewAgentStateReset(input) {
      events.push(`preview_reset:${input.scope}`)
      return {
        scope: input.scope,
        ...(input.scope !== 'knowledge' ? {
          context: { ledgerEntries: 7, checkpoints: 1, runtimeStates: 1 },
        } : {}),
        ...(input.scope !== 'context' ? {
          knowledge: { directories: [
            { name: 'memory' as const, exists: true, files: 2 },
            { name: 'notebook' as const, exists: true, files: 1 },
          ] },
        } : {}),
        ...(input.scope === 'all' ? {
          workspace: {
            preservedFiles: ['.gitignore', 'README.md'] as const,
            entries: [
              { name: 'browser', kind: 'directory' as const, files: 18 },
              { name: 'runtime', kind: 'directory' as const, files: 3 },
            ],
          },
        } : {}),
      }
    },
    async resetAgentState(input) {
      events.push(`execute_reset:${input.scope}`)
      return {
        scope: input.scope,
        deletedLedgerEntries: 7,
        deletedCheckpoints: 1,
        deletedRuntimeStates: 1,
        createdRuntimeState: true,
        removedDirectories: input.scope === 'context' ? [] : ['memory', 'notebook'],
        removedWorkspaceEntries: input.scope === 'all' ? 2 : 0,
      }
    },
  }
}

describe('createAdminOperationsPort', () => {
  test('previews reset state without mutating it', async () => {
    const events: string[] = []
    const preview = await createAdminOperationsPort(dependencies(events)).preview({
      operation: 'reset_state',
      scope: 'all',
    })

    assert.equal(preview.payload.operation, 'reset_state')
    assert.equal(preview.payload.scope, 'all')
    assert.equal(preview.payload.needed, true)
    assert.equal(preview.payload.workspace?.entries.length, 2)
    assert.match(preview.stateFingerprint, /^[a-f0-9]{64}$/)
    assert.deepEqual(events, ['preview_reset:all'])
  })

  test('revalidates the preview, guards the Bot, and executes only reset', async () => {
    const events: string[] = []
    const port = createAdminOperationsPort(dependencies(events))
    const admin = createAdminOperationsService(port, {
      now: () => new Date('2026-07-21T10:00:00.000Z'),
      id: () => 'preview-1',
      hash: value => createHash('sha256').update(value).digest('hex'),
      previewTtlMs: 60_000,
    })
    const preview = await admin.createPreview({ operation: 'reset_state', scope: 'knowledge' })
    events.length = 0

    const result = await admin.execute(
      { previewId: preview.id, confirmation: preview.confirmationPhrase },
      async () => undefined,
    )

    assert.equal(result.operation, 'reset_state')
    assert.equal(result.scope, 'knowledge')
    assert.deepEqual(events, [
      'inspect_bot',
      'preview_reset:knowledge',
      'assert_bot_stopped',
      'execute_reset:knowledge',
    ])
  })
})

describe('startOperationWithRuntime', () => {
  test('does not submit a run until confirmation, guard, and stale preflight pass', async () => {
    const events: string[] = []
    await assert.rejects(
      startOperationWithRuntime(
        { previewId: 'preview-1', confirmation: 'wrong' },
        {
          async preflight() {
            events.push('preflight')
            throw Object.assign(new Error('confirmation_mismatch'), { code: 'confirmation_mismatch' })
          },
          async submit() {
            events.push('submit')
            throw new Error('must not submit')
          },
        },
      ),
      /confirmation_mismatch/,
    )

    assert.deepEqual(events, ['preflight'])
  })
})

test('sanitizes unexpected server errors before they cross the browser boundary', () => {
  const error = sanitizeOperationServerError(new Error('password=hunter2 database exploded'))

  assert.equal(error.code, 'operation_request_failed')
  assert.doesNotMatch(error.message, /hunter2|database exploded/)
})

test('redacts plain, JSON, bearer, and database secrets from app-log diagnostics', () => {
  const redacted = redactOperationDiagnostic([
    'password=hunter2',
    '{"token":"json-secret"}',
    "'secret' = 'quoted-secret'",
    'Authorization: Bearer abc.def.ghi',
    'Authorization: Basic basic-secret',
    'Cookie: session=cookie-secret',
    'Set-Cookie: session=set-cookie-secret',
    'postgresql://user:pass@localhost/db',
    'mongodb://mongo:pass@localhost/db',
    'mysql://mysql:pass@localhost/db',
    'redis://redis:pass@localhost/0',
  ].join('\n'))

  assert.doesNotMatch(redacted, /hunter2|json-secret|quoted-secret|abc\.def|basic-secret|cookie-secret|user:pass|mongo:pass|mysql:pass|redis:pass/)
  assert.match(redacted, /\[REDACTED\]/)
})
