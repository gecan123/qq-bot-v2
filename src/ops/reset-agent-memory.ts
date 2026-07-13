import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const MEMORY_DIRECTORIES = ['memory', 'journal', 'life', 'notebook'] as const

export interface AgentMemoryResetDb {
  botAgentSnapshot: { deleteMany(): Promise<{ count: number }> }
  botAgentGoal: { deleteMany(): Promise<{ count: number }> }
}

export interface AgentMemoryResetResult {
  deletedSnapshots: number
  deletedGoals: number
  removedDirectories: string[]
}

export async function resetAgentMemory(options: {
  db: AgentMemoryResetDb
  workspaceDir: string
}): Promise<AgentMemoryResetResult> {
  const [snapshots, goals] = await Promise.all([
    options.db.botAgentSnapshot.deleteMany(),
    options.db.botAgentGoal.deleteMany(),
  ])

  const removedDirectories: string[] = []
  for (const directory of MEMORY_DIRECTORIES) {
    await rm(join(options.workspaceDir, directory), { recursive: true, force: true })
    removedDirectories.push(directory)
  }

  return {
    deletedSnapshots: snapshots.count,
    deletedGoals: goals.count,
    removedDirectories,
  }
}
