import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentContext } from './agent-context.js'
import { AGENT_LEDGER_SCHEMA_VERSION, AGENT_RUNTIME_STATE_SCHEMA_VERSION } from './agent-ledger.types.js'
import type { AgentLedgerRepo } from './agent-ledger-repo.js'
import { createEmptyMailboxContinuityState } from './mailbox-continuity.js'
import { createLedgerCommitCoordinator } from './ledger-commit-coordinator.js'

describe('LedgerCommitCoordinator', () => {
  test('installs appended messages and runtime state without reloading canonical history', async () => {
    const context = createAgentContext({ initialMessages: [{ role: 'user', content: 'before' }] })
    let installedHead: bigint | null = null
    let loads = 0
    const runtimeState = {
      schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
      mailboxCursors: {}, inboxReadCursors: {}, mailboxContinuity: createEmptyMailboxContinuityState(),
      conversationFocus: null,
      lastWakeAt: null,
      ledgerHeadEntryId: 2n,
    }
    const repo = {
      async loadCanonicalState() { loads++; throw new Error('must not reload') },
      async appendMessages(input: Parameters<AgentLedgerRepo['appendMessages']>[0]) {
        assert.equal(input.expectedHeadEntryId, 1n)
        return {
          appendedEntries: [{
            id: 2n, entryType: 'message' as const,
            payload: { schemaVersion: AGENT_LEDGER_SCHEMA_VERSION, message: input.messages[0]! },
            createdAt: new Date('2026-08-23T00:00:00Z'),
          }],
          runtimeState,
        }
      },
    } as unknown as AgentLedgerRepo
    const coordinator = createLedgerCommitCoordinator({
      context,
      repo,
      getExpectedHeadEntryId: () => 1n,
      installRuntimeState: state => { installedHead = state.ledgerHeadEntryId },
    })

    await coordinator.commit({ messages: [{ role: 'user', content: 'after' }] })

    assert.deepEqual(context.getSnapshot().messages, [
      { role: 'user', content: 'before' },
      { role: 'user', content: 'after' },
    ])
    assert.equal(installedHead, 2n)
    assert.equal(loads, 0)
  })
})
