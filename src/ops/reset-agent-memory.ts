import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_RUNTIME_STATE_SCHEMA_VERSION } from '../agent/agent-ledger.types.js'
import { createEmptyMailboxContinuityState } from '../agent/mailbox-continuity.js'

const MEMORY_DIRECTORIES = ['memory', 'journal', 'life', 'notebook'] as const

export interface AgentMemoryResetTx {
  botAgentLedgerEntry: { deleteMany(): Promise<{ count: number }> }
  botAgentCheckpoint: { deleteMany(): Promise<{ count: number }> }
  botAgentRuntimeState: {
    deleteMany(): Promise<{ count: number }>
    create(input: { data: Record<string, unknown> }): Promise<unknown>
  }
  botAgentGoal: { deleteMany(): Promise<{ count: number }> }
}

export interface AgentMemoryResetDb {
  $transaction<T>(run: (tx: AgentMemoryResetTx) => Promise<T>): Promise<T>
}

export interface AgentMemoryResetResult {
  deletedLedgerEntries: number
  deletedCheckpoints: number
  deletedRuntimeStates: number
  deletedGoals: number
  createdRuntimeState: true
  removedDirectories: string[]
}

export async function resetAgentMemory(options: {
  db: AgentMemoryResetDb
  workspaceDir: string
}): Promise<AgentMemoryResetResult> {
  const deleted = await options.db.$transaction(async (tx) => {
    const checkpoints = await tx.botAgentCheckpoint.deleteMany()
    const ledgerEntries = await tx.botAgentLedgerEntry.deleteMany()
    const goals = await tx.botAgentGoal.deleteMany()
    const runtimeStates = await tx.botAgentRuntimeState.deleteMany()
    await tx.botAgentRuntimeState.create({
      data: {
        id: 1,
        schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
        mailboxCursors: {},
        mailboxContinuity: createEmptyMailboxContinuityState(),
        goalRevision: 0,
        activeToolCapabilities: [],
        qqConversationFocus: null,
        lastWakeAt: null,
        ledgerHeadEntryId: null,
      },
    })
    return { checkpoints, ledgerEntries, goals, runtimeStates }
  })

  const removedDirectories: string[] = []
  for (const directory of MEMORY_DIRECTORIES) {
    await rm(join(options.workspaceDir, directory), { recursive: true, force: true })
    removedDirectories.push(directory)
  }

  return {
    deletedLedgerEntries: deleted.ledgerEntries.count,
    deletedCheckpoints: deleted.checkpoints.count,
    deletedRuntimeStates: deleted.runtimeStates.count,
    deletedGoals: deleted.goals.count,
    createdRuntimeState: true,
    removedDirectories,
  }
}
