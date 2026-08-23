import { performance } from 'node:perf_hooks'
import { createAgentContext } from '../src/agent/agent-context.js'
import { createLedgerCommitCoordinator } from '../src/agent/ledger-commit-coordinator.js'
import { projectAgentLedger } from '../src/agent/agent-ledger-projection.js'
import type { AgentLedgerRepo } from '../src/agent/agent-ledger-repo.js'
import {
  AGENT_LEDGER_SCHEMA_VERSION,
  AGENT_RUNTIME_STATE_SCHEMA_VERSION,
  type AgentLedgerEntry,
  type AgentRuntimeState,
} from '../src/agent/agent-ledger.types.js'
import { createEmptyMailboxContinuityState } from '../src/agent/mailbox-continuity.js'
import { log } from '../src/logger.js'

log.level = 'silent'

const sizes = process.argv.slice(2).map(Number).filter(value => Number.isSafeInteger(value) && value > 2)
const entryCounts = sizes.length > 0 ? sizes : [10_000, 100_000]
const activeMessageCount = 200
const commitIterations = 50

for (const entryCount of entryCounts) {
  const canonical = buildCompactedCanonical(entryCount, activeMessageCount)
  const fullStartedAt = performance.now()
  const projection = projectAgentLedger(canonical)
  const fullReplayMs = performance.now() - fullStartedAt

  const context = createAgentContext()
  context.installProjection(projection.snapshot)
  let expectedHeadEntryId = canonical.runtimeState.ledgerHeadEntryId
  const repo = createBenchmarkRepo(canonical.runtimeState, () => expectedHeadEntryId)
  const coordinator = createLedgerCommitCoordinator({
    context,
    repo,
    getExpectedHeadEntryId: () => expectedHeadEntryId,
    installRuntimeState: state => { expectedHeadEntryId = state.ledgerHeadEntryId },
  })

  const incrementalStartedAt = performance.now()
  for (let index = 0; index < commitIterations; index++) {
    await coordinator.commit({ messages: [{ role: 'user', content: `incremental-${index}` }] })
  }
  const incrementalCommitMs = (performance.now() - incrementalStartedAt) / commitIterations

  process.stdout.write(`${JSON.stringify({
    permanentEntryCount: entryCount,
    activeMessagesBeforeCommit: projection.snapshot.messages.length,
    commitIterations,
    fullReplayMs: roundMs(fullReplayMs),
    averageIncrementalCommitMs: roundMs(incrementalCommitMs),
    activeMessagesAfterCommits: context.getSnapshot().messages.length,
  })}\n`)
}

function buildCompactedCanonical(entryCount: number, requestedActiveCount: number): {
  entries: AgentLedgerEntry[]
  runtimeState: AgentRuntimeState
} {
  const createdAt = new Date('2026-08-23T00:00:00.000Z')
  const messageCount = entryCount - 1
  const activeCount = Math.min(requestedActiveCount, messageCount)
  const boundaryId = messageCount - activeCount + 1
  const entries: AgentLedgerEntry[] = Array.from({ length: messageCount }, (_, index) => ({
    id: BigInt(index + 1),
    entryType: 'message' as const,
    payload: {
      schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
      message: { role: 'user' as const, content: `message-${index + 1}` },
    },
    createdAt,
  }))
  entries.push({
    id: BigInt(entryCount),
    entryType: 'compaction',
    payload: {
      schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
      summary: 'benchmark summary',
      firstKeptEntryId: String(boundaryId),
      tokensBefore: messageCount * 8,
      estimatedTokensAfter: activeCount * 8,
      reason: 'threshold',
      isSplitTurn: false,
      previousCompactionEntryId: null,
      mailboxAttentionState: {},
    },
    createdAt,
  })
  return {
    entries,
    runtimeState: {
      schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
      mailboxCursors: {},
      inboxReadCursors: {},
      mailboxContinuity: createEmptyMailboxContinuityState(),
      goalRevision: 0,
      conversationFocus: null,
      lastWakeAt: null,
      ledgerHeadEntryId: BigInt(entryCount),
    },
  }
}

function createBenchmarkRepo(
  initialRuntimeState: AgentRuntimeState,
  currentExpectedHead: () => bigint | null,
): AgentLedgerRepo {
  let nextId = initialRuntimeState.ledgerHeadEntryId ?? 0n
  return {
    async appendMessages(input) {
      if (input.expectedHeadEntryId !== currentExpectedHead()) throw new Error('benchmark expected-head drift')
      nextId += 1n
      const message = input.messages[0]
      if (!message || input.messages.length !== 1) throw new Error('benchmark expects one message per commit')
      return {
        appendedEntries: [{
          id: nextId,
          entryType: 'message',
          payload: { schemaVersion: AGENT_LEDGER_SCHEMA_VERSION, message: structuredClone(message) },
          createdAt: new Date('2026-08-23T00:00:00.000Z'),
        }],
        runtimeState: { ...initialRuntimeState, ledgerHeadEntryId: nextId },
      }
    },
  } as AgentLedgerRepo
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}
