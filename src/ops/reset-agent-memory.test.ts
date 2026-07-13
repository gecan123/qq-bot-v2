import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { resetAgentMemory } from './reset-agent-memory.js'

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

      const result = await resetAgentMemory({
        workspaceDir,
        db: {
          botAgentSnapshot: { deleteMany: async () => ({ count: 1 }) },
          botAgentGoal: { deleteMany: async () => ({ count: 1 }) },
        },
      })

      assert.deepEqual(result, {
        deletedSnapshots: 1,
        deletedGoals: 1,
        removedDirectories: ['memory', 'journal', 'life', 'notebook'],
      })
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
      const result = await resetAgentMemory({
        workspaceDir,
        db: {
          botAgentSnapshot: { deleteMany: async () => ({ count: 0 }) },
          botAgentGoal: { deleteMany: async () => ({ count: 0 }) },
        },
      })
      assert.equal(result.deletedSnapshots, 0)
      assert.equal(result.deletedGoals, 0)
    } finally {
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })
})
