import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SNAPSHOT_SCHEMA_VERSION, type DurableAgentMessage } from './agent-context.types.js'
import {
  AGENT_LEDGER_SCHEMA_VERSION,
  AGENT_RUNTIME_STATE_SCHEMA_VERSION,
  type AgentLedgerEntry,
  type AgentRuntimeState,
} from './agent-ledger.types.js'
import {
  AGENT_CHECKPOINT_SCHEMA_VERSION,
  createAgentLedgerLoader,
  fingerprintCanonicalAgentState,
} from './agent-ledger-loader.js'
import type {
  AgentCheckpointInput,
  AgentLedgerRepo,
  CanonicalAgentState,
  StoredAgentCheckpoint,
} from './agent-ledger-repo.js'
import { createEmptyMailboxContinuityState } from './mailbox-continuity.js'
import { buildWorkingContextProjection } from './working-context.js'
import { buildClaudeCodeRequestBody } from './claude-code/request.js'
import { buildOpenAIAgentRequest } from './openai-agent/llm-client.js'

const CREATED_AT = new Date('2026-07-15T12:00:00.000Z')

function messageEntry(id: bigint, content: string): AgentLedgerEntry {
  return agentEntry(id, { role: 'user', content })
}

function agentEntry(id: bigint, message: DurableAgentMessage): AgentLedgerEntry {
  return {
    id,
    entryType: 'message',
    payload: {
      schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
      message,
    },
    createdAt: CREATED_AT,
  }
}

function runtimeState(head: bigint | null): AgentRuntimeState {
  return {
    schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
    mailboxCursors: {},
    inboxReadCursors: {},
    mailboxContinuity: createEmptyMailboxContinuityState(),
    goalRevision: 0,
    qqConversationFocus: null,
    lastWakeAt: null,
    ledgerHeadEntryId: head,
  }
}

function canonical(entries: AgentLedgerEntry[]): CanonicalAgentState {
  return { entries, runtimeState: runtimeState(entries.at(-1)?.id ?? null) }
}

function createFakeRepo(initial: CanonicalAgentState): {
  repo: AgentLedgerRepo
  setCanonical(value: CanonicalAgentState): void
  setCheckpoint(value: StoredAgentCheckpoint | null): void
  checkpoint(): StoredAgentCheckpoint | null
  saveCount(): number
  failCheckpointSaves(): void
} {
  let current = structuredClone(initial)
  let checkpoint: StoredAgentCheckpoint | null = null
  let saves = 0
  let failSaves = false
  const repo: AgentLedgerRepo = {
    async loadCanonicalState() {
      return structuredClone(current)
    },
    async loadCheckpoint() {
      return structuredClone(checkpoint)
    },
    async saveCheckpoint(input: AgentCheckpointInput) {
      saves++
      if (failSaves) throw new Error('checkpoint unavailable')
      checkpoint = {
        ...structuredClone(input),
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      }
    },
    async appendMessages() {
      throw new Error('not used')
    },
    async appendCompaction() {
      throw new Error('not used')
    },
    async updateRuntime() {
      throw new Error('not used')
    },
  }
  return {
    repo,
    setCanonical(value) { current = structuredClone(value) },
    setCheckpoint(value) { checkpoint = structuredClone(value) },
    checkpoint: () => structuredClone(checkpoint),
    saveCount: () => saves,
    failCheckpointSaves() { failSaves = true },
  }
}

describe('createAgentLedgerLoader', () => {
  test('rebuilds from canonical ledger when checkpoint is absent', async () => {
    const fake = createFakeRepo(canonical([messageEntry(1n, 'hello')]))
    const loader = createAgentLedgerLoader({ repo: fake.repo })

    const loaded = await loader.load()

    assert.equal(loaded.checkpointStatus, 'missing')
    assert.deepEqual(loaded.projection.snapshot.messages, [{ role: 'user', content: 'hello' }])
    assert.equal(fake.saveCount(), 1)
    assert.equal(fake.checkpoint()?.throughEntryId, 1n)
  })

  test('uses checkpoint only when head, schema, fingerprint, and projection all match', async () => {
    const fake = createFakeRepo(canonical([messageEntry(1n, 'hello')]))
    const loader = createAgentLedgerLoader({ repo: fake.repo })
    await loader.load()
    const savesAfterWarmup = fake.saveCount()

    const loaded = await loader.load()

    assert.equal(loaded.checkpointStatus, 'hit')
    assert.equal(fake.saveCount(), savesAfterWarmup)
    assert.deepEqual(loaded.projection.snapshot.messages, [{ role: 'user', content: 'hello' }])
  })

  test('rebuilds and overwrites a stale checkpoint', async () => {
    const first = canonical([messageEntry(1n, 'one')])
    const fake = createFakeRepo(first)
    const loader = createAgentLedgerLoader({ repo: fake.repo })
    await loader.load()
    fake.setCanonical(canonical([messageEntry(1n, 'one'), messageEntry(2n, 'two')]))

    const loaded = await loader.load()

    assert.equal(loaded.checkpointStatus, 'stale')
    assert.equal(fake.saveCount(), 2)
    assert.equal(fake.checkpoint()?.throughEntryId, 2n)
    assert.deepEqual(loaded.projection.snapshot.messages.map((message) => message.content), ['one', 'two'])
  })

  test('rebuilds and overwrites a corrupt checkpoint projection', async () => {
    const state = canonical([messageEntry(1n, 'one')])
    const fake = createFakeRepo(state)
    fake.setCheckpoint({
      schemaVersion: AGENT_CHECKPOINT_SCHEMA_VERSION,
      throughEntryId: 1n,
      fingerprint: fingerprintCanonicalAgentState(state),
      projection: {
        snapshot: {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          messages: [{ role: 'future', content: 'bad' }],
        },
        activeEntryCount: 1,
        permanentEntryCount: 1,
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    const loader = createAgentLedgerLoader({ repo: fake.repo })

    const loaded = await loader.load()

    assert.equal(loaded.checkpointStatus, 'corrupt')
    assert.deepEqual(loaded.projection.snapshot.messages, [{ role: 'user', content: 'one' }])
    assert.equal(fake.saveCount(), 1)
  })

  test('fails closed on corrupt canonical ledger even when checkpoint metadata matches', async () => {
    const corrupt: CanonicalAgentState = {
      entries: [{
        id: 1n,
        entryType: 'message',
        payload: {
          schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'lookup', args: {} }],
          },
        },
        createdAt: CREATED_AT,
      }],
      runtimeState: runtimeState(1n),
    }
    const fake = createFakeRepo(corrupt)
    fake.setCheckpoint({
      schemaVersion: AGENT_CHECKPOINT_SCHEMA_VERSION,
      throughEntryId: 1n,
      fingerprint: fingerprintCanonicalAgentState(corrupt),
      projection: {
        snapshot: {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          messages: [],
        },
        activeEntryCount: 0,
        permanentEntryCount: 1,
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    const loader = createAgentLedgerLoader({ repo: fake.repo })

    await assert.rejects(loader.load(), /must be tool result for assistant tool call call-1/)
    assert.equal(fake.saveCount(), 0)
  })

  test('does not fail canonical recovery when checkpoint refresh fails', async () => {
    const fake = createFakeRepo(canonical([messageEntry(1n, 'hello')]))
    fake.failCheckpointSaves()
    const loader = createAgentLedgerLoader({ repo: fake.repo })

    const loaded = await loader.load()

    assert.equal(loaded.checkpointStatus, 'missing')
    assert.deepEqual(loaded.projection.snapshot.messages, [{ role: 'user', content: 'hello' }])
  })

  test('cache hit, stale rebuild, and canonical replay produce byte-identical LLM requests', async () => {
    const state = canonical([
      agentEntry(1n, { role: 'user', content: '查一下 notes' }),
      agentEntry(2n, {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'workspace_bash', args: { command: 'ls notes' } }],
      }),
      agentEntry(3n, { role: 'tool', toolCallId: 'call-1', content: '{"ok":true}' }),
      agentEntry(4n, { role: 'assistant', content: '找到了。', toolCalls: [] }),
    ])
    const fake = createFakeRepo(state)
    const loader = createAgentLedgerLoader({ repo: fake.repo })

    const rebuilt = await loader.load()
    const cached = await loader.load()
    const staleCheckpoint = fake.checkpoint()
    assert.ok(staleCheckpoint)
    fake.setCheckpoint({ ...staleCheckpoint, fingerprint: 'stale' })
    const stale = await loader.load()

    assert.equal(rebuilt.checkpointStatus, 'missing')
    assert.equal(cached.checkpointStatus, 'hit')
    assert.equal(stale.checkpointStatus, 'stale')
    assert.equal(
      JSON.stringify(rebuilt.projection.snapshot),
      JSON.stringify(cached.projection.snapshot),
    )
    assert.equal(
      JSON.stringify(rebuilt.projection.snapshot),
      JSON.stringify(stale.projection.snapshot),
    )

    const requests = await Promise.all(
      [rebuilt, cached, stale].map(async loaded => {
        const working = await buildWorkingContextProjection(loaded.projection.snapshot.messages)
        return {
          claude: buildClaudeCodeRequestBody({
            model: 'claude-sonnet-4-6',
            systemPrompt: 'stable system',
            messages: working.messages,
            tools: [],
          }),
          openai: buildOpenAIAgentRequest({
            model: 'gpt-5.1',
            systemPrompt: 'stable system',
            messages: working.messages,
            tools: [],
          }),
        }
      }),
    )
    const canonicalBytes = JSON.stringify(requests[0])
    assert.equal(JSON.stringify(requests[1]), canonicalBytes)
    assert.equal(JSON.stringify(requests[2]), canonicalBytes)
  })
})
