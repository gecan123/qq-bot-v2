import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { AGENT_RUNTIME_STATE_SCHEMA_VERSION } from '../agent/agent-ledger.types.js'
import { createEmptyMailboxContinuityState } from '../agent/mailbox-continuity.js'
import {
  parseAgentStateResetScope,
  previewAgentStateReset,
  resetAgentState,
  type AgentStateResetDb,
  type AgentStateResetPreviewDb,
  type AgentStateResetScope,
} from './reset-agent-state.js'

const DEFAULT_RESET_COUNTS = {
  ledgerEntries: 7,
  checkpoints: 1,
  runtimeStates: 1,
}

const DEFAULT_RUNTIME_CONTINUITY = {
  mailboxCursors: {
    'feishu:cli_test:private:oc_test': 1129,
  },
  inboxReadCursors: {
    'feishu:cli_test:private:oc_test': 1129,
  },
  lastWakeAt: new Date('2026-08-26T07:05:00.000Z'),
}

function fakeResetDb(
  counts = DEFAULT_RESET_COUNTS,
  runtimeContinuity: {
    mailboxCursors: unknown
    inboxReadCursors: unknown
    lastWakeAt: Date | null
  } | null = counts.runtimeStates > 0 ? DEFAULT_RUNTIME_CONTINUITY : null,
): { db: AgentStateResetDb; transactions: number; created: unknown[] } {
  const created: unknown[] = []
  const state = { transactions: 0 }
  const tx = {
    botAgentLedgerEntry: { deleteMany: async () => ({ count: counts.ledgerEntries }) },
    botAgentCheckpoint: { deleteMany: async () => ({ count: counts.checkpoints }) },
    botAgentRuntimeState: {
      findUnique: async () => runtimeContinuity,
      deleteMany: async () => ({ count: counts.runtimeStates }),
      create: async (input: unknown) => { created.push(input); return input },
    },
  }
  return {
    created,
    get transactions() { return state.transactions },
    db: {
      async $transaction(run) {
        state.transactions++
        return run(tx)
      },
    },
  }
}

async function createWorkspace(): Promise<string> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-state-reset-'))
  await writeFile(join(workspaceDir, 'README.md'), 'workspace contract', 'utf8')
  await writeFile(join(workspaceDir, '.gitignore'), '*', 'utf8')
  await writeFile(join(workspaceDir, '.DS_Store'), 'generated metadata', 'utf8')
  for (const directory of ['memory', 'notebook']) {
    await mkdir(join(workspaceDir, directory), { recursive: true })
    await writeFile(join(workspaceDir, directory, 'old.md'), 'old state', 'utf8')
  }
  await mkdir(join(workspaceDir, 'notes'), { recursive: true })
  await writeFile(join(workspaceDir, 'notes', 'keep.md'), 'keep', 'utf8')
  await mkdir(join(workspaceDir, 'browser', 'screenshots'), { recursive: true })
  await writeFile(join(workspaceDir, 'browser', 'screenshots', 'old.png'), 'image', 'utf8')
  await mkdir(join(workspaceDir, 'runtime'), { recursive: true })
  await writeFile(join(workspaceDir, 'runtime', 'schedules.json'), '{}', 'utf8')
  await mkdir(join(workspaceDir, 'drafts'), { recursive: true })
  return workspaceDir
}

async function assertManagedStatePresent(workspaceDir: string): Promise<void> {
  for (const directory of ['memory', 'notebook']) {
    assert.equal(await readFile(join(workspaceDir, directory, 'old.md'), 'utf8'), 'old state')
  }
}

async function assertGeneratedWorkspacePresent(workspaceDir: string): Promise<void> {
  assert.equal(await readFile(join(workspaceDir, '.DS_Store'), 'utf8'), 'generated metadata')
  assert.equal(await readFile(join(workspaceDir, 'notes', 'keep.md'), 'utf8'), 'keep')
  assert.equal(await readFile(join(workspaceDir, 'browser', 'screenshots', 'old.png'), 'utf8'), 'image')
  assert.equal(await readFile(join(workspaceDir, 'runtime', 'schedules.json'), 'utf8'), '{}')
  await access(join(workspaceDir, 'drafts'))
}

function fakePreviewDb(counts = {
  ledgerEntries: 7,
  checkpoints: 1,
  runtimeStates: 1,
}): AgentStateResetPreviewDb {
  return {
    botAgentLedgerEntry: { count: async () => counts.ledgerEntries },
    botAgentCheckpoint: { count: async () => counts.checkpoints },
    botAgentRuntimeState: { count: async () => counts.runtimeStates },
  }
}

async function createPreviewWorkspace(): Promise<string> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-state-reset-preview-'))
  await writeFile(join(workspaceDir, 'README.md'), 'workspace contract', 'utf8')
  await writeFile(join(workspaceDir, '.gitignore'), '*', 'utf8')
  await mkdir(join(workspaceDir, 'memory', 'nested'), { recursive: true })
  await writeFile(join(workspaceDir, 'memory', 'one.md'), 'one', 'utf8')
  await writeFile(join(workspaceDir, 'memory', 'nested', 'two.md'), 'two', 'utf8')
  await mkdir(join(workspaceDir, 'notebook'), { recursive: true })
  await writeFile(join(workspaceDir, 'notebook', 'one.md'), 'one', 'utf8')
  await mkdir(join(workspaceDir, 'runtime'), { recursive: true })
  await writeFile(join(workspaceDir, 'runtime', 'schedules.json'), '{}', 'utf8')
  await writeFile(join(workspaceDir, 'notes.md'), 'ordinary generated file', 'utf8')
  return workspaceDir
}

describe('previewAgentStateReset', () => {
  test('reports context row counts without starting a transaction', async () => {
    const workspaceDir = await createPreviewWorkspace()
    try {
      const preview = await previewAgentStateReset({
        scope: 'context',
        workspaceDir,
        db: fakePreviewDb(),
      })

      assert.deepEqual(preview, {
        scope: 'context',
        context: { ledgerEntries: 7, checkpoints: 1, runtimeStates: 1 },
      })
      await assertManagedStatePresentForPreview(workspaceDir)
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  test('reports fixed knowledge directories and recursively counts files', async () => {
    const workspaceDir = await createPreviewWorkspace()
    try {
      const preview = await previewAgentStateReset({ scope: 'knowledge', workspaceDir })

      assert.deepEqual(preview, {
        scope: 'knowledge',
        knowledge: {
          directories: [
            { name: 'memory', exists: true, files: 2 },
            { name: 'notebook', exists: true, files: 1 },
          ],
        },
      })
      await assertManagedStatePresentForPreview(workspaceDir)
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  test('combines context, knowledge, and full generated workspace sections for all scope', async () => {
    const workspaceDir = await createPreviewWorkspace()
    try {
      const preview = await previewAgentStateReset({
        scope: 'all',
        workspaceDir,
        db: fakePreviewDb(),
      })

      assert.equal(preview.scope, 'all')
      assert.deepEqual(preview.context, {
        ledgerEntries: 7,
        checkpoints: 1,
        runtimeStates: 1,
      })
      assert.equal(preview.knowledge?.directories.length, 2)
      assert.deepEqual(preview.workspace, {
        preservedFiles: ['.gitignore', 'README.md'],
        entries: [
          { name: 'memory', kind: 'directory', files: 2 },
          { name: 'notebook', kind: 'directory', files: 1 },
          { name: 'notes.md', kind: 'file', files: 1 },
          { name: 'runtime', kind: 'directory', files: 1 },
        ],
      })
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  test('requires a database only for context-bearing previews', async () => {
    const workspaceDir = await createPreviewWorkspace()
    try {
      await assert.rejects(
        previewAgentStateReset({ scope: 'context', workspaceDir }),
        /database is required for reset preview scope context/,
      )
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })
})

async function assertManagedStatePresentForPreview(workspaceDir: string): Promise<void> {
  assert.equal(await readFile(join(workspaceDir, 'memory', 'one.md'), 'utf8'), 'one')
  assert.equal(await readFile(join(workspaceDir, 'memory', 'nested', 'two.md'), 'utf8'), 'two')
  assert.equal(await readFile(join(workspaceDir, 'notebook', 'one.md'), 'utf8'), 'one')
}

describe('resetAgentState', () => {
  test('CLI validates scope before loading database configuration', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' }
    for (const name of [
      'LLM_DEFAULT_PROVIDER',
      'LLM_DEFAULT_MODEL',
      'LLM_MODEL_CONTEXT_WINDOWS_JSON',
    ]) {
      delete env[name]
    }
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/reset-agent-state.ts', '--confirm'],
      { cwd: process.cwd(), env, encoding: 'utf8' },
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--scope is required/)
    assert.doesNotMatch(result.stderr, /Missing required environment variable/)
  })

  test('requires exactly one explicit valid scope', () => {
    assert.equal(parseAgentStateResetScope(['--scope', 'all']), 'all')
    assert.equal(parseAgentStateResetScope(['--scope', 'context']), 'context')
    assert.equal(parseAgentStateResetScope(['--scope', 'knowledge']), 'knowledge')
    assert.throws(() => parseAgentStateResetScope([]), /--scope is required/)
    assert.throws(() => parseAgentStateResetScope(['--scope', 'runtime']), /invalid reset scope/)
    assert.throws(
      () => parseAgentStateResetScope(['--scope', 'all', '--scope', 'knowledge']),
      /exactly one --scope/,
    )
  })

  test('context clears canonical context while preserving delivery continuity and knowledge', async () => {
    const workspaceDir = await createWorkspace()
    try {
      const fake = fakeResetDb()
      const result = await resetAgentState({ scope: 'context', workspaceDir, db: fake.db })

      assert.equal(fake.transactions, 1)
      assert.equal(result.scope, 'context')
      assert.equal(result.deletedLedgerEntries, 7)
      assert.deepEqual(result.removedDirectories, [])
      assert.equal(result.removedWorkspaceEntries, 0)
      await assertManagedStatePresent(workspaceDir)
      await assertGeneratedWorkspacePresent(workspaceDir)
      assert.deepEqual(fake.created, [{
        data: {
          id: 1,
          schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
          mailboxCursors: DEFAULT_RUNTIME_CONTINUITY.mailboxCursors,
          inboxReadCursors: DEFAULT_RUNTIME_CONTINUITY.inboxReadCursors,
          mailboxContinuity: createEmptyMailboxContinuityState(),
          conversationFocus: null,
          lastWakeAt: DEFAULT_RUNTIME_CONTINUITY.lastWakeAt,
          ledgerHeadEntryId: null,
        },
      }])
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  test('context drops invalid delivery continuity while preserving valid cursors', async () => {
    const workspaceDir = await createWorkspace()
    try {
      const fake = fakeResetDb(DEFAULT_RESET_COUNTS, {
        mailboxCursors: {
          'qq_private:123': 9,
          'invalid-mailbox': 10,
        },
        inboxReadCursors: {
          'feishu:cli_test:private:oc_test': 8,
          'qq_private:456': -1,
        },
        lastWakeAt: new Date(Number.NaN),
      })

      await resetAgentState({ scope: 'context', workspaceDir, db: fake.db })

      const created = fake.created[0] as { data: Record<string, unknown> }
      assert.deepEqual(created.data.mailboxCursors, { 'qq_private:123': 9 })
      assert.deepEqual(created.data.inboxReadCursors, {
        'feishu:cli_test:private:oc_test': 8,
      })
      assert.equal(created.data.lastWakeAt, null)
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  test('knowledge clears managed Markdown without requiring a database', async () => {
    const workspaceDir = await createWorkspace()
    try {
      const result = await resetAgentState({ scope: 'knowledge', workspaceDir })

      assert.equal(result.scope, 'knowledge')
      assert.equal(result.deletedLedgerEntries, 0)
      assert.equal(result.createdRuntimeState, false)
      assert.deepEqual(result.removedDirectories, ['memory', 'notebook'])
      assert.equal(result.removedWorkspaceEntries, 0)
      for (const directory of result.removedDirectories) {
        await assert.rejects(access(join(workspaceDir, directory)))
      }
      await assertGeneratedWorkspacePresent(workspaceDir)
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  test('all clears every generated workspace entry, preserves contracts, and remains idempotent', async () => {
    const workspaceDir = await createWorkspace()
    try {
      const first = fakeResetDb()
      const firstResult = await resetAgentState({ scope: 'all', workspaceDir, db: first.db })
      assert.equal(first.transactions, 1)
      assert.equal(firstResult.createdRuntimeState, true)
      assert.deepEqual(firstResult.removedDirectories, ['memory', 'notebook'])
      assert.equal(firstResult.removedWorkspaceEntries, 7)
      assert.equal(await readFile(join(workspaceDir, 'README.md'), 'utf8'), 'workspace contract')
      assert.equal(await readFile(join(workspaceDir, '.gitignore'), 'utf8'), '*')
      assert.deepEqual((await readdir(workspaceDir)).sort(), ['.gitignore', 'README.md'])

      const empty = fakeResetDb({ ledgerEntries: 0, checkpoints: 0, runtimeStates: 0 })
      const secondResult = await resetAgentState({ scope: 'all', workspaceDir, db: empty.db })
      assert.equal(secondResult.deletedLedgerEntries, 0)
      assert.deepEqual(secondResult.removedDirectories, ['memory', 'notebook'])
      assert.equal(secondResult.removedWorkspaceEntries, 0)
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  test('rejects a missing database for context-bearing scopes', async () => {
    const workspaceDir = await createWorkspace()
    try {
      for (const scope of ['context', 'all'] satisfies AgentStateResetScope[]) {
        await assert.rejects(resetAgentState({ scope, workspaceDir }), /database is required/)
      }
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })
})
