import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { resetAgentMemory, type AgentMemoryResetDb } from './reset-agent-memory.js'

function fakeResetDb(counts: {
  ledgerEntries: number
  checkpoints: number
  runtimeStates: number
  goals: number
}): { db: AgentMemoryResetDb; created: unknown[] } {
  const created: unknown[] = []
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
    db: {
      async $transaction(run) { return run(tx) },
    },
  }
}

describe('resetAgentMemory', () => {
  test('clears persistent context and managed memory directories while preserving ordinary workspace files', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-memory-reset-'))
    try {
      for (const directory of ['memory', 'journal', 'life', 'notebook']) {
        await mkdir(join(workspaceDir, directory), { recursive: true })
        await writeFile(join(workspaceDir, directory, 'old.md'), 'old memory', 'utf8')
      }
      await mkdir(join(workspaceDir, 'notes'), { recursive: true })
      await writeFile(join(workspaceDir, 'notes', 'keep.md'), 'keep', 'utf8')

      const fake = fakeResetDb({ ledgerEntries: 7, checkpoints: 1, runtimeStates: 1, goals: 1 })
      const result = await resetAgentMemory({ workspaceDir, db: fake.db })

      assert.deepEqual(result, {
        deletedLedgerEntries: 7,
        deletedCheckpoints: 1,
        deletedRuntimeStates: 1,
        deletedGoals: 1,
        createdRuntimeState: true,
        removedDirectories: ['memory', 'journal', 'life', 'notebook'],
      })
      assert.deepEqual(fake.created, [{
        data: {
          id: 1,
          schemaVersion: 2,
          mailboxCursors: {},
          mailboxContinuity: {
            schemaVersion: 1,
            roundSeq: 0,
            lastInputTokens: null,
            compactionEpoch: 0,
            mailboxes: {},
          },
          goalRevision: 0,
          activeToolCapabilities: [],
          qqConversationFocus: null,
          lastWakeAt: null,
          ledgerHeadEntryId: null,
        },
      }])
      for (const directory of ['memory', 'journal', 'life', 'notebook']) {
        await assert.rejects(access(join(workspaceDir, directory)))
      }
      assert.equal(await readFile(join(workspaceDir, 'notes', 'keep.md'), 'utf8'), 'keep')
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  test('is idempotent when rows and directories are already absent', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-memory-reset-empty-'))
    try {
      const fake = fakeResetDb({ ledgerEntries: 0, checkpoints: 0, runtimeStates: 0, goals: 0 })
      const result = await resetAgentMemory({ workspaceDir, db: fake.db })
      assert.equal(result.deletedLedgerEntries, 0)
      assert.equal(result.deletedRuntimeStates, 0)
      assert.equal(result.deletedGoals, 0)
      assert.equal(fake.created.length, 1)
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })
})
