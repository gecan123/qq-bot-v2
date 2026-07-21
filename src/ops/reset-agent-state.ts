import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_RUNTIME_STATE_SCHEMA_VERSION } from '../agent/agent-ledger.types.js'
import { createEmptyMailboxContinuityState } from '../agent/mailbox-continuity.js'

const KNOWLEDGE_DIRECTORIES = ['memory', 'journal', 'life', 'notebook'] as const
const RESET_SCOPES = ['all', 'context', 'knowledge'] as const

export type AgentStateResetScope = (typeof RESET_SCOPES)[number]

export interface AgentStateResetTx {
  botAgentLedgerEntry: { deleteMany(): Promise<{ count: number }> }
  botAgentCheckpoint: { deleteMany(): Promise<{ count: number }> }
  botAgentRuntimeState: {
    deleteMany(): Promise<{ count: number }>
    create(input: { data: Record<string, unknown> }): Promise<unknown>
  }
  botAgentGoal: { deleteMany(): Promise<{ count: number }> }
}

export interface AgentStateResetDb {
  $transaction<T>(run: (tx: AgentStateResetTx) => Promise<T>): Promise<T>
}

export interface AgentStateResetPreviewDb {
  botAgentLedgerEntry: { count(): Promise<number> }
  botAgentCheckpoint: { count(): Promise<number> }
  botAgentRuntimeState: { count(): Promise<number> }
  botAgentGoal: { count(): Promise<number> }
}

export interface AgentStateResetPreview {
  scope: AgentStateResetScope
  context?: {
    ledgerEntries: number
    checkpoints: number
    runtimeStates: number
    goals: number
  }
  knowledge?: {
    directories: Array<{
      name: (typeof KNOWLEDGE_DIRECTORIES)[number]
      exists: boolean
      files: number
    }>
  }
}

export interface AgentStateResetResult {
  scope: AgentStateResetScope
  deletedLedgerEntries: number
  deletedCheckpoints: number
  deletedRuntimeStates: number
  deletedGoals: number
  createdRuntimeState: boolean
  removedDirectories: string[]
}

export function parseAgentStateResetScope(argv: readonly string[]): AgentStateResetScope {
  const indexes = argv.flatMap((arg, index) => arg === '--scope' ? [index] : [])
  if (indexes.length === 0) throw new Error('--scope is required')
  if (indexes.length !== 1) throw new Error('reset requires exactly one --scope')
  const value = argv[indexes[0]! + 1]
  if (!RESET_SCOPES.includes(value as AgentStateResetScope)) {
    throw new Error(`invalid reset scope "${value ?? ''}" (expected all, context, or knowledge)`)
  }
  return value as AgentStateResetScope
}

export async function previewAgentStateReset(options: {
  scope: AgentStateResetScope
  db?: AgentStateResetPreviewDb
  workspaceDir: string
}): Promise<AgentStateResetPreview> {
  const preview: AgentStateResetPreview = { scope: options.scope }

  if (options.scope === 'all' || options.scope === 'context') {
    if (!options.db) throw new Error(`database is required for reset preview scope ${options.scope}`)
    const [ledgerEntries, checkpoints, runtimeStates, goals] = await Promise.all([
      options.db.botAgentLedgerEntry.count(),
      options.db.botAgentCheckpoint.count(),
      options.db.botAgentRuntimeState.count(),
      options.db.botAgentGoal.count(),
    ])
    preview.context = { ledgerEntries, checkpoints, runtimeStates, goals }
  }

  if (options.scope === 'all' || options.scope === 'knowledge') {
    preview.knowledge = {
      directories: await Promise.all(KNOWLEDGE_DIRECTORIES.map(async name => {
        const count = await countFiles(join(options.workspaceDir, name))
        return { name, exists: count !== null, files: count ?? 0 }
      })),
    }
  }

  return preview
}

export async function resetAgentState(options: {
  scope: AgentStateResetScope
  db?: AgentStateResetDb
  workspaceDir: string
}): Promise<AgentStateResetResult> {
  const result: AgentStateResetResult = {
    scope: options.scope,
    deletedLedgerEntries: 0,
    deletedCheckpoints: 0,
    deletedRuntimeStates: 0,
    deletedGoals: 0,
    createdRuntimeState: false,
    removedDirectories: [],
  }

  if (options.scope === 'all' || options.scope === 'context') {
    if (!options.db) throw new Error(`database is required for reset scope ${options.scope}`)
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
          inboxReadCursors: {},
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
    result.deletedLedgerEntries = deleted.ledgerEntries.count
    result.deletedCheckpoints = deleted.checkpoints.count
    result.deletedRuntimeStates = deleted.runtimeStates.count
    result.deletedGoals = deleted.goals.count
    result.createdRuntimeState = true
  }

  if (options.scope === 'all' || options.scope === 'knowledge') {
    for (const directory of KNOWLEDGE_DIRECTORIES) {
      await rm(join(options.workspaceDir, directory), { recursive: true, force: true })
      result.removedDirectories.push(directory)
    }
  }

  return result
}

async function countFiles(directory: string): Promise<number | null> {
  const pending = [directory]
  let visitedEntries = 0
  let files = 0
  while (pending.length > 0) {
    let entries
    try {
      entries = await readdir(pending.pop()!, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && visitedEntries === 0) return null
      throw error
    }
    for (const entry of entries) {
      visitedEntries += 1
      if (visitedEntries > 10_000) throw new Error(`reset preview directory entry limit exceeded: ${directory}`)
      if (entry.isDirectory()) pending.push(join(entry.parentPath, entry.name))
      else files += 1
    }
  }
  return files
}
