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
import type { OperationRequest } from './operations.schema.js'

function dependencies(events: string[]): AdminOperationsAdapterDependencies {
  return {
    repositoryRoot: '/repo',
    workspaceRoot: '/repo/data/agent-workspace',
    db: {} as AdminOperationsAdapterDependencies['db'],
    loadMemoryEvidence: async () => [],
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
          context: { ledgerEntries: 7, checkpoints: 1, runtimeStates: 1, goals: 1 },
        } : {}),
        ...(input.scope !== 'context' ? {
          knowledge: { directories: [
            { name: 'memory' as const, exists: true, files: 2 },
            { name: 'journal' as const, exists: false, files: 0 },
            { name: 'life' as const, exists: true, files: 1 },
            { name: 'notebook' as const, exists: true, files: 1 },
          ] },
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
        deletedGoals: 1,
        createdRuntimeState: true,
        removedDirectories: input.scope === 'context' ? [] : ['memory', 'journal', 'life', 'notebook'],
      }
    },
    async migrateMemoryToV2(input) {
      events.push(`memory:${input.apply === true ? 'execute' : 'preview'}`)
      return {
        ok: true,
        applied: input.apply === true,
        needed: true,
        stateFingerprint: 'a'.repeat(64),
        ...(input.apply === true ? { backupDir: '/repo/data/agent-workspace/db-backups/memory-v2' } : {}),
        filesBefore: 2,
        filesAfter: 3,
        entries: 4,
        movedPersonEntries: 1,
        quarantinedPersonEntries: 1,
        changes: [{ from: 'groups/1.md', to: 'people/2/groups/1.md', entryId: 'entry-1', reason: 'person_extracted_from_group' }],
        warnings: [],
      }
    },
    async canonicalizeSelfTopicMemory(input) {
      events.push(`canonical:${input.apply === true ? 'execute' : 'preview'}`)
      return {
        ok: true,
        applied: input.apply === true,
        needed: true,
        stateFingerprint: 'b'.repeat(64),
        ...(input.apply === true ? { backupDir: '/repo/data/agent-workspace/db-backups/canonical' } : {}),
        filesBefore: 4,
        filesAfter: 2,
        entries: 5,
        consolidatedFiles: 4,
        sourceFiles: ['self/a.md', 'topics/b.md'],
        targets: ['self/self.md', 'topics/topics.md'],
      }
    },
    async planLongTermStateLanguageMigration() {
      events.push('language:preview')
      return {
        totalItems: 2,
        estimatedBatches: 1,
        counts: {
          memoryTitles: 1,
          memoryEntries: 1,
          notebookTopics: 0,
          notebookEntries: 0,
          lifeJournalEntries: 0,
          agendaItems: 0,
        },
        items: [
          { key: 'memory:title', text: 'Old title', kind: 'title' },
          { key: 'memory:entry', text: 'Old entry', kind: 'content' },
        ],
        stateFingerprint: createHash('sha256').update('language-state').digest('hex'),
        repairableJournalEntries: 0,
      }
    },
    async createLanguageTranslator() {
      events.push('language:create_translator')
      return async (items, onProgress) => {
        onProgress?.({ completedBatches: 1, totalBatches: 1 })
        return items.map(item => ({ key: item.key, text: '中文结果' }))
      }
    },
    async migrateLongTermStateToChinese(input) {
      events.push('language:execute')
      await input.translate([
        { key: 'memory:title', text: 'Old title', kind: 'title' },
      ])
      return {
        backupDir: '/repo/data/agent-workspace/db-backups/language',
        repairedNestedJournalEntries: 0,
        translated: {
          memoryTitles: 1,
          memoryEntries: 1,
          notebookTopics: 0,
          notebookEntries: 0,
          lifeJournalEntries: 0,
          agendaItems: 0,
        },
        renamedMemoryFiles: [{ from: 'self/old.md', to: 'self/new.md' }],
        translatedItems: 2,
      }
    },
  }
}

describe('createAdminOperationsPort', () => {
  test('maps each preview request exactly once and never creates the LLM translator', async () => {
    const events: string[] = []
    const port = createAdminOperationsPort(dependencies(events))
    const requests: OperationRequest[] = [
      { operation: 'reset_state', scope: 'all' },
      { operation: 'migrate_memory_v2' },
      { operation: 'canonicalize_memory' },
      { operation: 'migrate_state_language' },
    ]

    const previews = []
    for (const request of requests) previews.push(await port.preview(request))

    assert.deepEqual(previews.map(preview => preview.payload.operation), requests.map(request => request.operation))
    assert.equal(events.filter(event => event === 'preview_reset:all').length, 1)
    assert.equal(events.filter(event => event === 'memory:preview').length, 1)
    assert.equal(events.filter(event => event === 'canonical:preview').length, 1)
    assert.equal(events.filter(event => event === 'language:preview').length, 1)
    assert.equal(events.includes('language:create_translator'), false)
  })

  test('bounds memory preview details and uses the shared needed flag', async () => {
    const events: string[] = []
    const deps = dependencies(events)
    deps.migrateMemoryToV2 = async input => ({
      ok: true,
      applied: input.apply === true,
      needed: false,
      stateFingerprint: 'a'.repeat(64),
      filesBefore: 2,
      filesAfter: 2,
      entries: 70,
      movedPersonEntries: 0,
      quarantinedPersonEntries: 0,
      changes: Array.from({ length: 70 }, (_, index) => ({
        from: `self/${index}.md`,
        to: `self/${index}.md`,
        entryId: `entry-${index}`,
        reason: 'format_upgrade' as const,
      })),
      warnings: Array.from({ length: 25 }, (_, index) => `warning-${index}`),
    })

    const preview = await createAdminOperationsPort(deps).preview({ operation: 'migrate_memory_v2' })

    assert.equal(preview.payload.operation, 'migrate_memory_v2')
    if (preview.payload.operation === 'migrate_memory_v2') {
      assert.equal(preview.payload.needed, false)
      assert.equal(preview.payload.changes.length, 50)
      assert.equal(preview.payload.warnings.length, 20)
      assert.deepEqual(preview.payload.truncated, { changes: 20, warnings: 5 })
    }
  })

  test('keeps server-only state changes in the fingerprint when bounded payloads stay equal', async () => {
    const events: string[] = []
    const deps = dependencies(events)
    let hiddenState = 'first'
    deps.migrateMemoryToV2 = async input => ({
      ok: true,
      applied: input.apply === true,
      needed: true,
      stateFingerprint: createHash('sha256').update(hiddenState).digest('hex'),
      filesBefore: 70,
      filesAfter: 70,
      entries: 70,
      movedPersonEntries: 0,
      quarantinedPersonEntries: 0,
      changes: Array.from({ length: 70 }, (_, index) => ({
        from: `self/${index}.md`,
        to: `self/${index}.md`,
        entryId: `entry-${index}`,
        reason: 'format_upgrade' as const,
      })),
      warnings: [],
    })
    const port = createAdminOperationsPort(deps)

    const first = await port.preview({ operation: 'migrate_memory_v2' })
    hiddenState = 'changed-item-after-browser-cap'
    const second = await port.preview({ operation: 'migrate_memory_v2' })

    assert.deepEqual(second.payload, first.payload)
    assert.notEqual(second.stateFingerprint, first.stateFingerprint)
  })

  test('fingerprints raw language items without returning their text to the browser', async () => {
    const events: string[] = []
    const deps = dependencies(events)
    let text = 'Old title'
    deps.planLongTermStateLanguageMigration = async () => ({
      totalItems: 1,
      estimatedBatches: 1,
      counts: {
        memoryTitles: 1,
        memoryEntries: 0,
        notebookTopics: 0,
        notebookEntries: 0,
        lifeJournalEntries: 0,
        agendaItems: 0,
      },
      items: [{ key: 'memory:title', text, kind: 'title' }],
      stateFingerprint: createHash('sha256').update(text).digest('hex'),
      repairableJournalEntries: 0,
    })
    const port = createAdminOperationsPort(deps)

    const first = await port.preview({ operation: 'migrate_state_language' })
    text = 'Different private title'
    const second = await port.preview({ operation: 'migrate_state_language' })

    assert.deepEqual(second.payload, first.payload)
    assert.doesNotMatch(JSON.stringify(second.payload), /Different private title/)
    assert.notEqual(second.stateFingerprint, first.stateFingerprint)
  })

  test('marks a repair-only language plan as needed without exposing journal bytes', async () => {
    const deps = dependencies([])
    deps.planLongTermStateLanguageMigration = async () => ({
      totalItems: 0,
      estimatedBatches: 0,
      counts: {
        memoryTitles: 0,
        memoryEntries: 0,
        notebookTopics: 0,
        notebookEntries: 0,
        lifeJournalEntries: 0,
        agendaItems: 0,
      },
      items: [],
      stateFingerprint: createHash('sha256').update('repair-only-journal').digest('hex'),
      repairableJournalEntries: 1,
    })

    const preview = await createAdminOperationsPort(deps).preview({ operation: 'migrate_state_language' })

    assert.equal(preview.payload.operation, 'migrate_state_language')
    if (preview.payload.operation === 'migrate_state_language') {
      assert.equal(preview.payload.needed, true)
      assert.equal(preview.payload.repairableJournalEntries, 1)
    }
    assert.doesNotMatch(JSON.stringify(preview.payload), /repair-only-journal/)
  })

  test('revalidates the preview, then guards the Bot, then calls only the selected mutation', async () => {
    const events: string[] = []
    const port = createAdminOperationsPort(dependencies(events))
    const admin = createAdminOperationsService(port, {
      now: () => new Date('2026-07-21T10:00:00.000Z'),
      id: () => 'preview-1',
      hash: value => createHash('sha256').update(value).digest('hex'),
      previewTtlMs: 60_000,
    })
    const preview = await admin.createPreview({ operation: 'canonicalize_memory' })
    events.length = 0

    const result = await admin.execute(
      { previewId: preview.id, confirmation: preview.confirmationPhrase },
      async () => undefined,
    )

    assert.equal(result.operation, 'canonicalize_memory')
    assert.deepEqual(events, [
      'inspect_bot',
      'canonical:preview',
      'assert_bot_stopped',
      'canonical:execute',
    ])
  })

  test('constructs the language translator only after the execute guard and reports progress', async () => {
    const events: string[] = []
    const port = createAdminOperationsPort(dependencies(events))
    const progress: unknown[] = []

    const result = await port.execute(
      { operation: 'migrate_state_language' },
      value => { progress.push(value) },
    )

    assert.equal(result.operation, 'migrate_state_language')
    assert.deepEqual(events, [
      'assert_bot_stopped',
      'language:execute',
      'language:create_translator',
    ])
    assert.deepEqual(progress, [{ phase: 'translating', completed: 1, total: 1 }])
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
