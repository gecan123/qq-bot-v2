import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { DurableAgentMessage } from '../agent/agent-context.types.js'
import {
  AGENT_LEDGER_SCHEMA_VERSION,
  AGENT_RUNTIME_STATE_SCHEMA_VERSION,
  type AgentLedgerEntry,
  type AgentRuntimeState,
} from '../agent/agent-ledger.types.js'
import type { CanonicalAgentState } from '../agent/agent-ledger-repo.js'
import { createEmptyMailboxContinuityState } from '../agent/mailbox-continuity.js'
import type { AgentImageRefStore } from '../media/agent-image-ref.js'
import type { AgentContextSurface } from './agent-context-surface.js'
import {
  buildCurrentAgentContextReport,
  createPrismaAgentContextReportSource,
} from './agent-context-report-source.js'

const generatedAt = '2026-07-16T12:00:00.000+08:00'

function runtimeState(head: bigint | null): AgentRuntimeState {
  return {
    schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
    mailboxCursors: {},
    mailboxContinuity: createEmptyMailboxContinuityState(),
    goalRevision: 0,
    activeToolCapabilities: [],
    qqConversationFocus: null,
    lastWakeAt: null,
    ledgerHeadEntryId: head,
  }
}

function canonical(messages: readonly DurableAgentMessage[]): CanonicalAgentState {
  const entries: AgentLedgerEntry[] = messages.map((message, index) => ({
    id: BigInt(index + 1),
    entryType: 'message',
    payload: { schemaVersion: AGENT_LEDGER_SCHEMA_VERSION, message: structuredClone(message) },
    createdAt: new Date('2026-07-16T01:00:00.000Z'),
  }))
  return { entries, runtimeState: runtimeState(entries.at(-1)?.id ?? null) }
}

const surface: AgentContextSurface = {
  schemaVersion: 2,
  generatedAt,
  provider: 'claude-code',
  model: 'claude-opus-4-7',
  contextWindowTokens: 1_000_000,
  fixedTokens: { systemIdentity: 1, botSystemPrompt: 1, visibleTools: 0 },
}

function buildInput(overrides: Partial<Parameters<typeof buildCurrentAgentContextReport>[0]> = {}) {
  return {
    source: {
      async loadCanonicalState() { return canonical([{ role: 'user', content: 'hello' }]) },
      async loadLatestAgentChatUsage() { return null },
    },
    surfaceRead: { status: 'available' as const, surface },
    surfaceStatus: 'available' as const,
    imageRefs: {
      async persist() { throw new Error('persist must not be called') },
      async resolve() { return null },
    },
    reserveTokens: 10_000,
    keepRecentTokens: 2_000,
    claudeThinkingMode: 'adaptive' as const,
    claudeThinkingRetention: 'active-tool-cycle' as const,
    generatedAt,
    fallbackModel: 'fallback-model',
    fallbackProvider: 'openai-agent' as const,
    fallbackContextWindowTokens: 400_000,
    ...overrides,
  }
}

describe('createPrismaAgentContextReportSource', () => {
  test('uses only exact raw canonical and latest agent.chat read queries', async () => {
    const state = canonical([{ role: 'user', content: 'hello' }])
    const calls: Array<{ name: string; input: unknown }> = []
    const db = {
      botAgentLedgerEntry: {
        async findMany(input: unknown) {
          calls.push({ name: 'ledger', input })
          return state.entries
        },
      },
      botAgentRuntimeState: {
        async findUnique(input: unknown) {
          calls.push({ name: 'runtime', input })
          return { id: 1, ...state.runtimeState, updatedAt: new Date(0) }
        },
      },
      agentTokenUsage: {
        async findFirst(input: unknown) {
          calls.push({ name: 'usage', input })
          return {
            ts: new Date('2026-07-16T01:02:03.004Z'),
            model: 'observed-model',
            inputTokens: 101,
            cachedTokens: 99,
            outputTokens: 7,
          }
        },
      },
    }
    Object.defineProperty(db, 'botAgentCheckpoint', {
      get() { throw new Error('checkpoint must not be accessed') },
    })

    const source = createPrismaAgentContextReportSource(db)
    assert.deepEqual(Object.keys(source).sort(), ['loadCanonicalState', 'loadLatestAgentChatUsage'])
    assert.deepEqual(await source.loadCanonicalState(), state)
    assert.deepEqual(await source.loadLatestAgentChatUsage(), {
      ts: '2026-07-16T09:02:03.004+08:00',
      model: 'observed-model',
      inputTokens: 101,
      cachedTokens: 99,
      outputTokens: 7,
    })
    assert.deepEqual(calls, [
      { name: 'ledger', input: { orderBy: { id: 'asc' } } },
      { name: 'runtime', input: { where: { id: 1 } } },
      {
        name: 'usage',
        input: {
          where: { operation: 'agent.chat' },
          orderBy: [{ ts: 'desc' }, { id: 'desc' }],
          select: {
            ts: true,
            model: true,
            inputTokens: true,
            cachedTokens: true,
            outputTokens: true,
          },
        },
      },
    ])
  })

  test('returns null when there is no provider usage', async () => {
    const state = canonical([])
    const source = createPrismaAgentContextReportSource({
      botAgentLedgerEntry: { async findMany() { return state.entries } },
      botAgentRuntimeState: { async findUnique() { return state.runtimeState } },
      agentTokenUsage: { async findFirst() { return null } },
    })

    assert.equal(await source.loadLatestAgentChatUsage(), null)
  })

  test('fails when the runtime singleton is missing', async () => {
    const source = createPrismaAgentContextReportSource({
      botAgentLedgerEntry: { async findMany() { return [] } },
      botAgentRuntimeState: { async findUnique() { return null } },
      agentTokenUsage: { async findFirst() { return null } },
    })

    await assert.rejects(source.loadCanonicalState(), /singleton row is missing/)
  })
})

describe('buildCurrentAgentContextReport', () => {
  test('projects canonical ledger and resolves working images without persisting', async () => {
    const state = canonical([
      {
        role: 'assistant', content: '', nativeBlocks: [],
        toolCalls: [{ id: 'call-1', name: 'image_tool', args: {} }],
      },
      {
        role: 'tool', toolCallId: 'call-1', content: [{
          type: 'image_ref', mediaId: '42', mediaType: 'image/png', description: 'fixture',
        }],
      },
    ])
    const resolved: string[] = []
    let persisted = 0
    const imageRefs: AgentImageRefStore = {
      async persist() {
        persisted++
        throw new Error('persist must not be called')
      },
      async resolve(ref) {
        resolved.push(ref.mediaId)
        return {
          type: 'image',
          source: { type: 'base64', media_type: ref.mediaType, data: 'aW1hZ2U=' },
        }
      },
    }

    const report = await buildCurrentAgentContextReport(buildInput({
      source: {
        async loadCanonicalState() { return state },
        async loadLatestAgentChatUsage() { return null },
      },
      imageRefs,
    }))

    assert.deepEqual(resolved, ['42'])
    assert.equal(persisted, 0)
    assert.deepEqual(report.messages, {
      canonical: 2,
      working: 2,
      hydratedImages: 1,
      omittedImages: 0,
      unavailableImages: 0,
    })
    assert.ok(report.categories.workingImages! > 0)
  })

  test('rereads once after a transient canonical projection mismatch', async () => {
    const state = canonical([{ role: 'user', content: 'hello' }])
    const transient = structuredClone(state)
    transient.runtimeState.ledgerHeadEntryId = 999n
    let canonicalReads = 0
    const report = await buildCurrentAgentContextReport(buildInput({
      source: {
        async loadCanonicalState() {
          canonicalReads++
          return canonicalReads === 1 ? transient : state
        },
        async loadLatestAgentChatUsage() { return null },
      },
    }))

    assert.equal(canonicalReads, 2)
    assert.equal(report.messages.canonical, 1)
  })

  test('fails closed after two corrupt canonical reads before reading provider usage', async () => {
    const state = canonical([{ role: 'user', content: 'hello' }])
    state.runtimeState.ledgerHeadEntryId = 999n
    let canonicalReads = 0
    let usageReads = 0

    await assert.rejects(
      buildCurrentAgentContextReport(buildInput({
        source: {
          async loadCanonicalState() { canonicalReads++; return state },
          async loadLatestAgentChatUsage() { usageReads++; return null },
        },
      })),
      /integrity validation failed/,
    )
    assert.equal(canonicalReads, 2)
    assert.equal(usageReads, 0)
  })

  test('passes Claude thinking mode and retention into analysis', async () => {
    const state = canonical([
      {
        role: 'assistant', content: '',
        nativeBlocks: [{ type: 'thinking', thinking: 'private reasoning', signature: 'sig' }],
        toolCalls: [{ id: 'call-1', name: 'demo', args: {} }],
      },
      { role: 'tool', toolCallId: 'call-1', content: 'done' },
      { role: 'user', content: 'closed cycle' },
    ])
    const source = {
      async loadCanonicalState() { return state },
      async loadLatestAgentChatUsage() { return null },
    }

    const disabled = await buildCurrentAgentContextReport(buildInput({
      source, claudeThinkingMode: 'disabled', claudeThinkingRetention: 'always',
    }))
    const closedCycle = await buildCurrentAgentContextReport(buildInput({
      source, claudeThinkingMode: 'adaptive', claudeThinkingRetention: 'active-tool-cycle',
    }))
    const retained = await buildCurrentAgentContextReport(buildInput({
      source, claudeThinkingMode: 'adaptive', claudeThinkingRetention: 'always',
    }))

    assert.equal(disabled.categories.assistantThinking, 0)
    assert.equal(closedCycle.categories.assistantThinking, 0)
    assert.ok(retained.categories.assistantThinking! > 0)
  })
})
