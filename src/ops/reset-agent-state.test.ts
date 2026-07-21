import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import {
  parseAgentStateResetScope,
  previewAgentStateReset,
  resetAgentState,
  type AgentStateResetDb,
  type AgentStateResetPreviewDb,
  type AgentStateResetScope,
} from './reset-agent-state.js'

function fakeResetDb(counts = {
  ledgerEntries: 7,
  checkpoints: 1,
  runtimeStates: 1,
  goals: 1,
}): { db: AgentStateResetDb; transactions: number; created: unknown[] } {
  const created: unknown[] = []
  const state = { transactions: 0 }
  const tx = {
    botAgentLedgerEntry: { deleteMany: async () => ({ count: counts.ledgerEntries }) },
    botAgentCheckpoint: { deleteMany: async () => ({ count: counts.checkpoints }) },
    botAgentRuntimeState: {
      deleteMany: async () => ({ count: counts.runtimeStates }),
      create: async (input: unknown) => { created.push(input); return input },
    },
    botAgentGoal: { deleteMany: async () => ({ count: counts.goals }) },
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
  for (const directory of ['memory', 'journal', 'life', 'notebook']) {
    await mkdir(join(workspaceDir, directory), { recursive: true })
    await writeFile(join(workspaceDir, directory, 'old.md'), 'old state', 'utf8')
  }
  await mkdir(join(workspaceDir, 'notes'), { recursive: true })
  await writeFile(join(workspaceDir, 'notes', 'keep.md'), 'keep', 'utf8')
  return workspaceDir
}

async function assertManagedStatePresent(workspaceDir: string): Promise<void> {
  for (const directory of ['memory', 'journal', 'life', 'notebook']) {
    assert.equal(await readFile(join(workspaceDir, directory, 'old.md'), 'utf8'), 'old state')
  }
}

function fakePreviewDb(counts = {
  ledgerEntries: 7,
  checkpoints: 1,
  runtimeStates: 1,
  goals: 1,
}): AgentStateResetPreviewDb {
  return {
    botAgentLedgerEntry: { count: async () => counts.ledgerEntries },
    botAgentCheckpoint: { count: async () => counts.checkpoints },
    botAgentRuntimeState: { count: async () => counts.runtimeStates },
    botAgentGoal: { count: async () => counts.goals },
  }
}

async function createPreviewWorkspace(): Promise<string> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-state-reset-preview-'))
  await mkdir(join(workspaceDir, 'memory', 'nested'), { recursive: true })
  await writeFile(join(workspaceDir, 'memory', 'one.md'), 'one', 'utf8')
  await writeFile(join(workspaceDir, 'memory', 'nested', 'two.md'), 'two', 'utf8')
  await mkdir(join(workspaceDir, 'life'), { recursive: true })
  await writeFile(join(workspaceDir, 'life', 'one.md'), 'one', 'utf8')
  await mkdir(join(workspaceDir, 'notebook'), { recursive: true })
  await writeFile(join(workspaceDir, 'notebook', 'one.md'), 'one', 'utf8')
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
        context: { ledgerEntries: 7, checkpoints: 1, runtimeStates: 1, goals: 1 },
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
            { name: 'journal', exists: false, files: 0 },
            { name: 'life', exists: true, files: 1 },
            { name: 'notebook', exists: true, files: 1 },
          ],
        },
      })
      await assertManagedStatePresentForPreview(workspaceDir)
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  test('combines context and knowledge sections for all scope', async () => {
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
        goals: 1,
      })
      assert.equal(preview.knowledge?.directories.length, 4)
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
  assert.equal(await readFile(join(workspaceDir, 'life', 'one.md'), 'utf8'), 'one')
  assert.equal(await readFile(join(workspaceDir, 'notebook', 'one.md'), 'utf8'), 'one')
  await assert.rejects(access(join(workspaceDir, 'journal')))
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
    assert.throws(() => parseAgentStateResetScope(['--scope', 'goal']), /invalid reset scope/)
    assert.throws(
      () => parseAgentStateResetScope(['--scope', 'all', '--scope', 'knowledge']),
      /exactly one --scope/,
    )
  })

  test('context clears canonical runtime state and Goal while preserving knowledge', async () => {
    const workspaceDir = await createWorkspace()
    try {
      const fake = fakeResetDb()
      const result = await resetAgentState({ scope: 'context', workspaceDir, db: fake.db })

      assert.equal(fake.transactions, 1)
      assert.equal(result.scope, 'context')
      assert.equal(result.deletedLedgerEntries, 7)
      assert.equal(result.deletedGoals, 1)
      assert.deepEqual(result.removedDirectories, [])
      await assertManagedStatePresent(workspaceDir)
      assert.equal(fake.created.length, 1)
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
      assert.deepEqual(result.removedDirectories, ['memory', 'journal', 'life', 'notebook'])
      for (const directory of result.removedDirectories) {
        await assert.rejects(access(join(workspaceDir, directory)))
      }
      assert.equal(await readFile(join(workspaceDir, 'notes', 'keep.md'), 'utf8'), 'keep')
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  test('all performs both scopes and remains idempotent', async () => {
    const workspaceDir = await createWorkspace()
    try {
      const first = fakeResetDb()
      const firstResult = await resetAgentState({ scope: 'all', workspaceDir, db: first.db })
      assert.equal(first.transactions, 1)
      assert.equal(firstResult.createdRuntimeState, true)
      assert.deepEqual(firstResult.removedDirectories, ['memory', 'journal', 'life', 'notebook'])

      const empty = fakeResetDb({ ledgerEntries: 0, checkpoints: 0, runtimeStates: 0, goals: 0 })
      const secondResult = await resetAgentState({ scope: 'all', workspaceDir, db: empty.db })
      assert.equal(secondResult.deletedLedgerEntries, 0)
      assert.equal(secondResult.deletedGoals, 0)
      assert.deepEqual(secondResult.removedDirectories, ['memory', 'journal', 'life', 'notebook'])
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
