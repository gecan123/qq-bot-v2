import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'vitest'
import {
  operationRequestSchema,
  type BotProcessStatusDto,
  type OperationPreviewPayload,
  type OperationRequest,
  type OperationResultPayload,
} from './operations.schema.js'
import {
  createAdminOperationsService,
  type AdminOperationsPort,
  type OperationProgressReporter,
} from './operations.service.js'

function stoppedBot(): BotProcessStatusDto {
  return { stopped: true, pid: null, reason: 'no_process' }
}

function resetPayload(scope: 'context' | 'knowledge' | 'all' = 'context'): OperationPreviewPayload {
  return {
    operation: 'reset_state',
    scope,
    needed: true,
    context: scope === 'knowledge'
      ? null
      : { ledgerEntries: 7, checkpoints: 1, runtimeStates: 1, goals: 1 },
    knowledge: scope === 'context'
      ? null
      : { directories: [
          { name: 'memory', exists: true, files: 2 },
          { name: 'journal', exists: false, files: 0 },
          { name: 'life', exists: true, files: 1 },
          { name: 'notebook', exists: true, files: 1 },
        ] },
  }
}

function resetResult(scope: 'context' | 'knowledge' | 'all' = 'context'): OperationResultPayload {
  return {
    operation: 'reset_state',
    scope,
    deletedLedgerEntries: 7,
    deletedCheckpoints: 1,
    deletedRuntimeStates: 1,
    deletedGoals: 1,
    createdRuntimeState: true,
    removedDirectories: [],
  }
}

function fakePort(input: {
  bot?: BotProcessStatusDto
  preview?: OperationPreviewPayload
} = {}): AdminOperationsPort & {
  previewRequests: OperationRequest[]
  executeRequests: OperationRequest[]
} {
  const previewRequests: OperationRequest[] = []
  const executeRequests: OperationRequest[] = []
  return {
    previewRequests,
    executeRequests,
    async inspectBot() { return input.bot ?? stoppedBot() },
    async preview(request) {
      previewRequests.push(request)
      return input.preview ?? resetPayload(request.operation === 'reset_state' ? request.scope : 'context')
    },
    async execute(request, _progress: OperationProgressReporter) {
      executeRequests.push(request)
      return resetResult(request.operation === 'reset_state' ? request.scope : 'context')
    },
  }
}

function service(port: AdminOperationsPort, overrides: { now?: () => Date; id?: () => string } = {}) {
  return createAdminOperationsService(port, {
    now: overrides.now ?? (() => new Date('2026-07-21T10:00:00.000Z')),
    id: overrides.id ?? (() => 'preview-1'),
    hash: value => createHash('sha256').update(value).digest('hex'),
    previewTtlMs: 60_000,
  })
}

describe('operationRequestSchema', () => {
  test('accepts only the four fixed operation shapes', () => {
    assert.deepEqual(operationRequestSchema.parse({ operation: 'reset_state', scope: 'all' }), {
      operation: 'reset_state',
      scope: 'all',
    })
    for (const operation of [
      'migrate_memory_v2',
      'canonicalize_memory',
      'migrate_state_language',
    ] as const) {
      assert.deepEqual(operationRequestSchema.parse({ operation }), { operation })
    }
  })

  test('rejects command names, paths, extra properties, and unknown operations', () => {
    for (const value of [
      { operation: 'reset_state', scope: 'all', command: 'rm' },
      { operation: 'migrate_memory_v2', rootDir: '/tmp/other' },
      { operation: 'canonicalize_memory', script: 'anything' },
      { operation: 'shell', command: 'pnpm test' },
    ]) {
      assert.equal(operationRequestSchema.safeParse(value).success, false)
    }
  })
})

describe('createAdminOperationsService', () => {
  test('canonicalizes previews into a stable SHA-256 fingerprint', async () => {
    let nextId = 0
    const admin = service(fakePort(), { id: () => `preview-${++nextId}` })

    const first = await admin.createPreview({ operation: 'reset_state', scope: 'context' })
    const second = await admin.createPreview({ operation: 'reset_state', scope: 'context' })

    assert.match(first.fingerprint, /^[a-f0-9]{64}$/)
    assert.equal(second.fingerprint, first.fingerprint)
    assert.notEqual(second.id, first.id)
  })

  test('returns a scope-specific reset confirmation phrase', async () => {
    const preview = await service(fakePort()).createPreview({
      operation: 'reset_state',
      scope: 'knowledge',
    })

    assert.match(preview.confirmationPhrase, /knowledge/)
  })

  test('marks a migration with no changes as unnecessary', async () => {
    const port = fakePort({
      preview: {
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
    })

    const preview = await service(port).createPreview({ operation: 'migrate_memory_v2' })

    assert.equal(preview.payload.needed, false)
  })

  test('rejects a mismatched confirmation phrase', async () => {
    const admin = service(fakePort())
    const preview = await admin.createPreview({ operation: 'reset_state', scope: 'context' })

    await assert.rejects(
      admin.execute({ previewId: preview.id, confirmation: 'wrong' }, async () => undefined),
      /confirmation_mismatch/,
    )
  })

  test('rejects an expired preview', async () => {
    let now = new Date('2026-07-21T10:00:00.000Z')
    const admin = service(fakePort(), { now: () => now })
    const preview = await admin.createPreview({ operation: 'reset_state', scope: 'context' })
    now = new Date('2026-07-21T10:02:00.000Z')

    await assert.rejects(
      admin.execute({ previewId: preview.id, confirmation: preview.confirmationPhrase }, async () => undefined),
      /preview_expired/,
    )
  })

  test('rejects a stale preview after re-reading operation inputs', async () => {
    const port = fakePort()
    const admin = service(port)
    const preview = await admin.createPreview({ operation: 'reset_state', scope: 'context' })
    port.preview = async request => ({
      ...resetPayload(request.operation === 'reset_state' ? request.scope : 'context'),
      context: { ledgerEntries: 8, checkpoints: 1, runtimeStates: 1, goals: 1 },
    })

    await assert.rejects(
      admin.execute({ previewId: preview.id, confirmation: preview.confirmationPhrase }, async () => undefined),
      /preview_stale/,
    )
  })

  test('rejects execution while the Bot is running', async () => {
    const port = fakePort()
    const admin = service(port)
    const preview = await admin.createPreview({ operation: 'reset_state', scope: 'context' })
    port.inspectBot = async () => ({ stopped: false, pid: 42, reason: 'pidfile_live' })

    await assert.rejects(
      admin.execute({ previewId: preview.id, confirmation: preview.confirmationPhrase }, async () => undefined),
      /bot_running/,
    )
  })

  test('executes only the typed operation stored in the preview', async () => {
    const port = fakePort()
    const admin = service(port)
    const preview = await admin.createPreview({ operation: 'reset_state', scope: 'all' })

    const result = await admin.execute(
      { previewId: preview.id, confirmation: preview.confirmationPhrase },
      async () => undefined,
    )

    assert.equal(result.operation, 'reset_state')
    assert.deepEqual(port.executeRequests, [{ operation: 'reset_state', scope: 'all' }])
  })
})
