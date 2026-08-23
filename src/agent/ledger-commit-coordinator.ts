import { SNAPSHOT_SCHEMA_VERSION, type DurableAgentMessage } from './agent-context.types.js'
import type { AgentContext } from './agent-context.js'
import type {
  AgentLedgerRepo,
  AgentRuntimePatch,
  AppendResult,
} from './agent-ledger-repo.js'
import type { AgentRuntimeState } from './agent-ledger.types.js'
import { createLogger } from '../logger.js'

const log = createLogger('LEDGER_COMMIT')

export interface LedgerCommitCoordinator {
  commit(input: {
    messages?: readonly DurableAgentMessage[]
    runtimePatch?: AgentRuntimePatch
  }): Promise<AgentRuntimeState | null>
}

export function createLedgerCommitCoordinator(input: {
  context: AgentContext
  repo: AgentLedgerRepo
  getExpectedHeadEntryId: () => bigint | null
  installRuntimeState: (state: AgentRuntimeState) => void
}): LedgerCommitCoordinator {
  return {
    async commit(change) {
      const startedAt = performance.now()
      const messages = change.messages ?? []
      if (messages.length === 0 && change.runtimePatch == null) return null
      let runtimeState: AgentRuntimeState
      let appendedMessages: DurableAgentMessage[] = []
      if (messages.length > 0) {
        const committed = await input.repo.appendMessages({
            expectedHeadEntryId: input.getExpectedHeadEntryId(),
            messages,
            ...(change.runtimePatch ? { runtimePatch: change.runtimePatch } : {}),
          })
        runtimeState = committed.runtimeState
        appendedMessages = messagesFromAppend(committed)
      } else {
        runtimeState = await input.repo.updateRuntime({
          expectedHeadEntryId: input.getExpectedHeadEntryId(),
          patch: change.runtimePatch!,
        })
      }

      const current = input.context.getSnapshot()
      input.context.installProjection({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        messages: [...current.messages, ...appendedMessages],
        conversationFocus: runtimeState.conversationFocus,
      })
      input.installRuntimeState(runtimeState)
      log.info({
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        appendedEntryCount: appendedMessages.length,
        mode: messages.length > 0 ? 'append' : 'runtime_only',
        ledgerHeadEntryId: runtimeState.ledgerHeadEntryId?.toString() ?? null,
      }, 'ledger_commit_completed')
      return runtimeState
    },
  }
}

function messagesFromAppend(result: AppendResult): DurableAgentMessage[] {
  return result.appendedEntries.map((entry) => {
    if (entry.entryType !== 'message') throw new Error('message commit returned a non-message ledger entry')
    return structuredClone(entry.payload.message)
  })
}
