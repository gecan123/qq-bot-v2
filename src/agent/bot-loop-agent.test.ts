import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createBotLoopAgent } from './bot-loop-agent.js'
import { createAgentContext } from './agent-context.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmCallInput, LlmClient, LlmCallOutput } from './llm-client.js'
import type { ToolExecutionResult, ToolExecutor } from './tool.js'
import type { PersistedAgentSnapshot } from './agent-context.types.js'
import type { AgentMessage } from './agent-context.types.js'
import type { AgentLedgerRepo, AgentRuntimePatch } from './agent-ledger-repo.js'
import { AgentLedgerHeadChangedError } from './agent-ledger-repo.js'
import type { AgentLedgerLoader } from './agent-ledger-loader.js'
import { createAgentLedgerLoader } from './agent-ledger-loader.js'
import {
  AGENT_RUNTIME_STATE_SCHEMA_VERSION,
  type AgentLedgerEntry,
  type AgentRuntimeState,
} from './agent-ledger.types.js'
import { projectAgentLedger } from './agent-ledger-projection.js'
import type { MailboxCursors } from './mailbox.js'
import type { AgentActivityReporter, AgentActivityTrigger } from './activity-surface.js'
import { renderBotEvent } from './render-event.js'
import { createInMemoryGoalStore } from './goal-store.js'
import {
  createEmptyMailboxContinuityState,
  MAILBOX_LIGHT_COMPENSATION_AFTER_MS,
  recordMailboxDisclosure,
  type MailboxContinuityState,
} from './mailbox-continuity.js'

function makeMockLlm(outputs: LlmCallOutput[]): LlmClient {
  let i = 0
  return {
    async chat() {
      const next = outputs[i] ?? outputs[outputs.length - 1]
      i++
      if (!next) throw new Error('mock LLM ran out of scripted outputs')
      return next
    },
  }
}

function validLedgerSummary(content = '保留关键历史。'): string {
  return [
    '## 讨论过的话题', content,
    '## 群友信息', '无。',
    '## 我的目标、承诺和状态', '继续当前目标。',
    '## 关键约束与决定', '遵守安全边界。',
    '## 工具调用结果', '无。',
    '## 情绪和氛围', '平静。',
    '## 下一步', '继续执行。',
  ].join('\n')
}

function makeScheduledWake(): Extract<BotEvent, { type: 'scheduled_wake' }> {
  return {
    type: 'scheduled_wake',
    scheduleId: 'schedule-1',
    name: '回看线索',
    scheduledFor: new Date('2026-07-13T09:00:00.000Z'),
  }
}

const TEST_GOAL_COMMITMENT = {
  action: '读取第一份证据',
  reason: '先建立可验证的证据基线',
  expectedEvidence: '一条带来源的事实记录',
}

function makeMockTools(impl: Record<string, () => Promise<ToolExecutionResult>> = {}): ToolExecutor {
  const noop = async () => ({ content: 'ok' })
  return {
    list: () => [],
    classify: () => ({ sideEffect: true, concurrency: 'exclusive' }),
    async execute(call) {
      const fn = impl[call.name] ?? noop
      return fn()
    },
  }
}

function makeMockLedgerHarness(
  contextMessages: readonly AgentMessage[],
  options: { failAppend?: boolean } = {},
): {
  repo: AgentLedgerRepo
  loader: AgentLedgerLoader
  appendCalls: Array<{ messages: AgentMessage[]; runtimePatch?: AgentRuntimePatch }>
  saved: PersistedAgentSnapshot[]
  savedCursors: Array<MailboxCursors | undefined>
  savedLastWakeAt: Array<Date | null>
  savedContinuity: Array<MailboxContinuityState | undefined>
} {
  let entries: AgentLedgerEntry[] = contextMessages.map((message, index) => ({
    id: BigInt(index + 1),
    entryType: 'message',
    payload: { schemaVersion: 1, message: structuredClone(message) },
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
  }))
  let nextId = BigInt(entries.length + 1)
  let runtimeState: AgentRuntimeState = {
    schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
    mailboxCursors: {},
    inboxReadCursors: {},
    mailboxContinuity: createEmptyMailboxContinuityState(),
    goalRevision: 0,
    qqConversationFocus: null,
    lastWakeAt: null,
    ledgerHeadEntryId: entries.at(-1)?.id ?? null,
  }
  const appendCalls: Array<{ messages: AgentMessage[]; runtimePatch?: AgentRuntimePatch }> = []
  const saved: PersistedAgentSnapshot[] = []
  const savedCursors: Array<MailboxCursors | undefined> = []
  const savedLastWakeAt: Array<Date | null> = []
  const savedContinuity: Array<MailboxContinuityState | undefined> = []
  const applyPatch = (patch: AgentRuntimePatch = {}): void => {
    runtimeState = {
      ...runtimeState,
      ...structuredClone(patch),
      lastWakeAt: patch.lastWakeAt === undefined ? runtimeState.lastWakeAt : patch.lastWakeAt,
    }
  }
  const recordCommittedState = (): void => {
    const projection = projectAgentLedger({ entries, runtimeState })
    saved.push(structuredClone(projection.snapshot))
    savedCursors.push(structuredClone(runtimeState.mailboxCursors))
    savedLastWakeAt.push(runtimeState.lastWakeAt == null ? null : new Date(runtimeState.lastWakeAt))
    savedContinuity.push(structuredClone(runtimeState.mailboxContinuity))
  }
  const repo: AgentLedgerRepo = {
    async loadCanonicalState() {
      return { entries: structuredClone(entries), runtimeState: structuredClone(runtimeState) }
    },
    async appendMessages(input) {
      appendCalls.push({
        messages: structuredClone([...input.messages]),
        ...(input.runtimePatch ? { runtimePatch: structuredClone(input.runtimePatch) } : {}),
      })
      if (options.failAppend) throw new Error('ledger commit failed')
      const appendedEntries: AgentLedgerEntry[] = input.messages.map((message) => ({
        id: nextId++,
        entryType: 'message',
        payload: { schemaVersion: 1, message: structuredClone(message) },
        createdAt: new Date('2026-07-15T00:00:01.000Z'),
      }))
      entries.push(...appendedEntries)
      applyPatch(input.runtimePatch)
      runtimeState.ledgerHeadEntryId = entries.at(-1)?.id ?? null
      recordCommittedState()
      return { appendedEntries, runtimeState: structuredClone(runtimeState) }
    },
    async appendCompaction(input) {
      if (input.expectedHeadEntryId !== runtimeState.ledgerHeadEntryId) {
        throw new AgentLedgerHeadChangedError(input.expectedHeadEntryId, runtimeState.ledgerHeadEntryId)
      }
      const entry: AgentLedgerEntry = {
        id: nextId++,
        entryType: 'compaction',
        payload: structuredClone(input.payload),
        createdAt: new Date('2026-07-15T00:00:02.000Z'),
      }
      entries.push(entry)
      applyPatch(input.runtimePatch)
      runtimeState.ledgerHeadEntryId = entry.id
      recordCommittedState()
      return { appendedEntries: [entry], runtimeState: structuredClone(runtimeState) }
    },
    async updateRuntime(input) {
      if (input.expectedHeadEntryId !== runtimeState.ledgerHeadEntryId) {
        throw new AgentLedgerHeadChangedError(input.expectedHeadEntryId, runtimeState.ledgerHeadEntryId)
      }
      applyPatch(input.patch)
      recordCommittedState()
      return structuredClone(runtimeState)
    },
    async saveCheckpoint() {},
    async loadCheckpoint() { return null },
  }
  const loader = createAgentLedgerLoader({ repo })
  return {
    repo,
    loader,
    appendCalls,
    saved,
    savedCursors,
    savedLastWakeAt,
    savedContinuity,
  }
}

function makeCanonicalCompactionHarness(
  seedMessages: readonly AgentMessage[],
  options: { headRaceOnce?: boolean; failCheckpoint?: boolean; failCompaction?: boolean } = {},
): {
  repo: AgentLedgerRepo
  loader: AgentLedgerLoader
  compactionCalls: Array<{ expectedHeadEntryId: bigint | null; payload: unknown }>
  checkpointAttempts: () => number
} {
  let entries: AgentLedgerEntry[] = seedMessages.map((message, index) => ({
    id: BigInt(index + 1),
    entryType: 'message' as const,
    payload: { schemaVersion: 1 as const, message: structuredClone(message) },
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
  }))
  let nextId = BigInt(entries.length + 1)
  let runtimeState: AgentRuntimeState = {
    schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
    mailboxCursors: {},
    inboxReadCursors: {},
    mailboxContinuity: createEmptyMailboxContinuityState(),
    goalRevision: 0,
    qqConversationFocus: null,
    lastWakeAt: null,
    ledgerHeadEntryId: entries.at(-1)?.id ?? null,
  }
  let raced = false
  let checkpointAttempts = 0
  const compactionCalls: Array<{ expectedHeadEntryId: bigint | null; payload: unknown }> = []
  const repo: AgentLedgerRepo = {
    async loadCanonicalState() {
      return { entries: structuredClone(entries), runtimeState: structuredClone(runtimeState) }
    },
    async appendMessages(input) {
      const appendedEntries: AgentLedgerEntry[] = input.messages.map((message) => ({
        id: nextId++,
        entryType: 'message' as const,
        payload: { schemaVersion: 1 as const, message: structuredClone(message) },
        createdAt: new Date('2026-07-15T00:00:00.000Z'),
      }))
      entries.push(...appendedEntries)
      runtimeState = {
        ...runtimeState,
        ...structuredClone(input.runtimePatch ?? {}),
        ledgerHeadEntryId: entries.at(-1)?.id ?? null,
      }
      return { appendedEntries, runtimeState: structuredClone(runtimeState) }
    },
    async appendCompaction(input) {
      compactionCalls.push(structuredClone(input))
      if (options.failCompaction) throw new Error('compaction commit failed')
      if (options.headRaceOnce && !raced) {
        raced = true
        const racedEntry: AgentLedgerEntry = {
          id: nextId++,
          entryType: 'message',
          payload: { schemaVersion: 1, message: { role: 'user', content: 'concurrent message' } },
          createdAt: new Date('2026-07-15T00:00:01.000Z'),
        }
        entries.push(racedEntry)
        runtimeState = { ...runtimeState, ledgerHeadEntryId: racedEntry.id }
        throw new AgentLedgerHeadChangedError(input.expectedHeadEntryId, racedEntry.id)
      }
      if (input.expectedHeadEntryId !== runtimeState.ledgerHeadEntryId) {
        throw new AgentLedgerHeadChangedError(
          input.expectedHeadEntryId,
          runtimeState.ledgerHeadEntryId,
        )
      }
      const entry: AgentLedgerEntry = {
        id: nextId++,
        entryType: 'compaction',
        payload: structuredClone(input.payload),
        createdAt: new Date('2026-07-15T00:00:02.000Z'),
      }
      entries.push(entry)
      runtimeState = {
        ...runtimeState,
        ...structuredClone(input.runtimePatch ?? {}),
        ledgerHeadEntryId: entry.id,
      }
      return { appendedEntries: [entry], runtimeState: structuredClone(runtimeState) }
    },
    async updateRuntime(input) {
      if (input.expectedHeadEntryId !== runtimeState.ledgerHeadEntryId) {
        throw new AgentLedgerHeadChangedError(
          input.expectedHeadEntryId,
          runtimeState.ledgerHeadEntryId,
        )
      }
      runtimeState = { ...runtimeState, ...structuredClone(input.patch) }
      return structuredClone(runtimeState)
    },
    async saveCheckpoint() {
      checkpointAttempts++
      if (options.failCheckpoint) throw new Error('checkpoint unavailable')
    },
    async loadCheckpoint() { return null },
  }
  return {
    repo,
    loader: createAgentLedgerLoader({ repo }),
    compactionCalls,
    checkpointAttempts: () => checkpointAttempts,
  }
}

// Note: 'send_group_message' references in fixtures below are intentionally retained as the
// historical (MVP-1) tool name, mirroring immutable ledger rows from before the MVP-2 rename.
// New code calls the tool 'send_message' (see src/agent/tools/send-message.ts).
describe('BotLoopAgent.runOnceForTest', () => {


  test('publishes a structured wake trigger and round phases to the disposable activity surface', async () => {
    const ctx = createAgentContext()
    const ledger = makeMockLedgerHarness([])
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_private_message',
      messageRowId: 99,
      peerId: 42,
      messageId: 100,
      senderId: 42,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date('2026-07-20T08:00:00.000Z'),
      renderedText: 'hello',
    })
    const phases: Array<Parameters<AgentActivityReporter['setPhase']>[0]> = []
    const triggers: Array<AgentActivityTrigger | null> = []
    const activityReporter: AgentActivityReporter = {
      setTrigger(trigger) { triggers.push(trigger) },
      setPhase(phase) { phases.push(phase) },
      toolStarted() {},
      toolFinished() {},
      async flush() {},
    }
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 3, cachedTokens: 0, outputTokens: 1 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools(),
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      activityReporter,
    })

    await agent.runOnceForTest()

    assert.equal(triggers[0]?.kind, 'private_message')
    assert.equal(triggers[0]?.label, '收到 Alice 的私聊')
    assert.deepEqual(phases.map(item => item.phase), ['thinking', 'committing'])
    assert.equal(phases[0]?.roundIndex, 1)
  })

  test('flush does not rewrite already canonical context', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('durable before shutdown')
    const { repo, loader, saved } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([]),
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.flush()

    assert.deepEqual(saved, [])
    assert.deepEqual(ctx.getSnapshot().messages, [
      { role: 'user', content: 'durable before shutdown' },
    ])
  })

  test('does not mutate AgentContext before ledger commit succeeds', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('durable input')
    const ledger = makeMockLedgerHarness(ctx.getSnapshot().messages, { failAppend: true })
    const toolCall = { id: 'lookup-commit-fail', name: 'lookup', args: {} }
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: [toolCall],
        usage: { inputTokens: 3, cachedTokens: 0, outputTokens: 2 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools({ lookup: async () => ({ content: '{"ok":true}' }) }),
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await assert.rejects(agent.runOnceForTest(), /ledger commit failed/)
    assert.deepEqual(ctx.getSnapshot().messages, [{ role: 'user', content: 'durable input' }])
  })

  test('ledger threshold compacts canonical history before the next LLM round', async () => {
    const seed = ['old-a', 'old-b', 'old-c', 'recent'].map((content) => ({
      role: 'user' as const,
      content,
    }))
    const ctx = createAgentContext({ initialMessages: seed })
    const ledger = makeCanonicalCompactionHarness(seed)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '', toolCalls: [],
        usage: { inputTokens: 91, cachedTokens: 0, outputTokens: 0 },
        model: 'mock', contextWindowTokens: 100, stopReason: 'end_turn',
      }]),
      tools: makeMockTools(),
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      initialLedgerHeadEntryId: 4n,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: {
        reserveTokens: 20,
        keepRecentTokens: 1,
        summarizeCandidate: async () => validLedgerSummary(),
      },
    })

    await agent.runOnceForTest()

    assert.equal(ledger.compactionCalls.length, 1)
    assert.match((ctx.getSnapshot().messages[0] as { content: string }).content, /^\[历史摘要\]/)
    assert.equal(ctx.getSnapshot().messages.at(-1)?.content, 'recent')
    const canonical = await ledger.repo.loadCanonicalState()
    assert.equal(canonical.runtimeState.mailboxContinuity.compactionEpoch, 1)
  })

  test('Claude compaction reuses the main system, tools, and raw projected prefix', async () => {
    const seed = ['old-a', 'old-b', 'old-c', 'recent'].map((content) => ({
      role: 'user' as const,
      content,
    }))
    const calls: LlmCallInput[] = []
    const llm: LlmClient = {
      provider: 'claude-code',
      async chat(input) {
        calls.push(input)
        if (calls.length === 1) {
          return {
            content: '', toolCalls: [],
            usage: { inputTokens: 91, cachedTokens: 0, outputTokens: 0 },
            model: 'mock', contextWindowTokens: 100, stopReason: 'end_turn',
          }
        }
        return {
          content: validLedgerSummary(), toolCalls: [],
          usage: { inputTokens: 80, cachedTokens: 70, outputTokens: 10 },
          model: 'mock', contextWindowTokens: 100, stopReason: 'end_turn',
        }
      },
    }
    const ctx = createAgentContext({ initialMessages: seed })
    const ledger = makeCanonicalCompactionHarness(seed)
    const tools = makeMockTools()
    const agent = createBotLoopAgent({
      systemPrompt: 'main system bytes',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm,
      tools,
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      initialLedgerHeadEntryId: 4n,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: { reserveTokens: 20, keepRecentTokens: 1 },
    })

    await agent.runOnceForTest()

    assert.equal(calls.length, 2)
    const compaction = calls[1]!
    assert.equal(compaction.systemPrompt, 'main system bytes')
    assert.deepEqual(compaction.messages.slice(0, -1), seed.slice(0, 3))
    assert.match(
      compaction.messages.at(-1)?.role === 'user'
        ? compaction.messages.at(-1)!.content as string
        : '',
      /trusted runtime compaction control/,
    )
    assert.deepEqual(compaction.tools, tools.list())
    assert.deepEqual(compaction.cacheBreakpointMessageIndexes, [2])
    assert.equal(compaction.claudeToolChoice, 'auto')
    assert.equal(ledger.compactionCalls.length, 1)
  })

  test('OpenAI compaction keeps the dedicated summarizer request shape', async () => {
    const seed = ['old-a', 'old-b', 'old-c', 'recent'].map((content) => ({
      role: 'user' as const,
      content,
    }))
    const calls: LlmCallInput[] = []
    const llm: LlmClient = {
      provider: 'openai-agent',
      async chat(input) {
        calls.push(input)
        return calls.length === 1
          ? {
              content: '', toolCalls: [],
              usage: { inputTokens: 91, cachedTokens: 0, outputTokens: 0 },
              model: 'mock', contextWindowTokens: 100, stopReason: 'end_turn',
            }
          : {
              content: validLedgerSummary(), toolCalls: [],
              usage: { inputTokens: 80, cachedTokens: 0, outputTokens: 10 },
              model: 'mock', contextWindowTokens: 100, stopReason: 'end_turn',
            }
      },
    }
    const ctx = createAgentContext({ initialMessages: seed })
    const ledger = makeCanonicalCompactionHarness(seed)
    const agent = createBotLoopAgent({
      systemPrompt: 'main system bytes',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm,
      tools: makeMockTools(),
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      initialLedgerHeadEntryId: 4n,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: { reserveTokens: 20, keepRecentTokens: 1 },
    })

    await agent.runOnceForTest()

    assert.equal(calls.length, 2)
    const compaction = calls[1]!
    assert.notEqual(compaction.systemPrompt, 'main system bytes')
    assert.match(compaction.systemPrompt, /compaction summarizer/)
    assert.deepEqual(compaction.tools, [])
    const text = compaction.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n')
    assert.match(text, /\[UNTRUSTED_DATA/)
    assert.equal(compaction.cacheBreakpointMessageIndexes, undefined)
    assert.equal(ledger.compactionCalls.length, 1)
  })

  test('ledger threshold includes tool output appended after the provider token prefix', async () => {
    const seed = ['old-a', 'old-b', 'old-c', 'recent'].map((content) => ({
      role: 'user' as const,
      content,
    }))
    const ctx = createAgentContext({ initialMessages: seed })
    const ledger = makeCanonicalCompactionHarness(seed)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'large-result', name: 'lookup', args: {} }],
        usage: { inputTokens: 60, cachedTokens: 0, outputTokens: 1 },
        model: 'mock',
        contextWindowTokens: 100,
        stopReason: 'tool_use',
      }]),
      tools: makeMockTools({
        lookup: async () => ({ content: JSON.stringify({ value: 'x'.repeat(200) }) }),
      }),
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      initialLedgerHeadEntryId: 4n,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: {
        reserveTokens: 20,
        keepRecentTokens: 1,
        summarizeCandidate: async () => validLedgerSummary(),
      },
    })

    await agent.runOnceForTest()

    assert.equal(ledger.compactionCalls.length, 1)
    const messages = ctx.getSnapshot().messages
    assert.match((messages[0] as { content: string }).content, /^\[历史摘要\]/)
    assert.equal(messages.at(-1)?.role, 'tool')
  })

  test('ledger summarizer failure writes no entry and backs threshold attempts off for ten minutes', async () => {
    const seed = ['old-a', 'old-b', 'old-c', 'recent'].map((content) => ({
      role: 'user' as const,
      content,
    }))
    const ctx = createAgentContext({ initialMessages: seed })
    const ledger = makeCanonicalCompactionHarness(seed)
    let summarizeAttempts = 0
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '', toolCalls: [],
        usage: { inputTokens: 91, cachedTokens: 0, outputTokens: 0 },
        model: 'mock', contextWindowTokens: 100, stopReason: 'end_turn',
      }]),
      tools: makeMockTools(),
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      initialLedgerHeadEntryId: 4n,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: {
        reserveTokens: 20,
        keepRecentTokens: 1,
        failureBackoffMs: 10 * 60_000,
        nowMs: () => 1_000,
        summarizeCandidate: async () => {
          summarizeAttempts++
          throw new Error('summarizer unavailable')
        },
      },
    })

    await agent.runOnceForTest()
    await agent.runOnceForTest()

    assert.equal(summarizeAttempts, 1)
    assert.equal(ledger.compactionCalls.length, 0)
    assert.deepEqual(ctx.getSnapshot().messages, seed)
  })

  test('shutdown aborts an in-flight canonical summarizer before it can commit', async () => {
    const seed = ['old-a', 'old-b', 'old-c', 'recent'].map((content) => ({
      role: 'user' as const,
      content,
    }))
    const ctx = createAgentContext({ initialMessages: seed })
    const ledger = makeCanonicalCompactionHarness(seed)
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const agent = createBotLoopAgent({
      systemPrompt: '', context: ctx, eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '', toolCalls: [], usage: { inputTokens: 91, cachedTokens: 0, outputTokens: 0 },
        model: 'mock', contextWindowTokens: 100, stopReason: 'end_turn',
      }]),
      tools: makeMockTools(), ledgerRepo: ledger.repo, ledgerLoader: ledger.loader,
      initialLedgerHeadEntryId: 4n, renderEvent: renderBotEvent, eventDebounceMs: 0,
      compactOptions: {
        reserveTokens: 20,
        keepRecentTokens: 1,
        summarizeCandidate: async (_request, { signal }) => {
          markStarted()
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return validLedgerSummary()
        },
      },
    })

    const running = agent.runOnceForTest()
    await started
    await agent.stop()
    await running

    assert.equal(ledger.compactionCalls.length, 0)
    assert.deepEqual(ctx.getSnapshot().messages, seed)
  })

  test('canonical compaction commit failure leaves the in-memory context unchanged', async () => {
    const seed = ['old-a', 'old-b', 'old-c', 'recent'].map((content) => ({
      role: 'user' as const,
      content,
    }))
    const ctx = createAgentContext({ initialMessages: seed })
    const ledger = makeCanonicalCompactionHarness(seed, { failCompaction: true })
    const agent = createBotLoopAgent({
      systemPrompt: '', context: ctx, eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '', toolCalls: [], usage: { inputTokens: 91, cachedTokens: 0, outputTokens: 0 },
        model: 'mock', contextWindowTokens: 100, stopReason: 'end_turn',
      }]),
      tools: makeMockTools(), ledgerRepo: ledger.repo, ledgerLoader: ledger.loader,
      initialLedgerHeadEntryId: 4n, renderEvent: renderBotEvent, eventDebounceMs: 0,
      compactOptions: {
        reserveTokens: 20, keepRecentTokens: 1,
        summarizeCandidate: async () => validLedgerSummary(),
      },
    })

    await agent.runOnceForTest()

    assert.equal(ledger.compactionCalls.length, 1)
    assert.deepEqual(ctx.getSnapshot().messages, seed)
  })

  test('ledger overflow forces one compact-and-retry and survives checkpoint failure', async () => {
    const seed = ['old-a', 'old-b', 'old-c', 'recent'].map((content) => ({
      role: 'user' as const,
      content,
    }))
    const ctx = createAgentContext({ initialMessages: seed })
    const ledger = makeCanonicalCompactionHarness(seed, { failCheckpoint: true })
    let llmCalls = 0
    const llm: LlmClient = {
      async chat() {
        llmCalls++
        if (llmCalls === 1) {
          throw Object.assign(new Error('prompt too long'), { kind: 'context_overflow' })
        }
        return {
          content: '', toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 0 },
          model: 'mock', contextWindowTokens: 100, stopReason: 'end_turn',
        }
      },
    }
    const agent = createBotLoopAgent({
      systemPrompt: '', context: ctx, eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm, tools: makeMockTools(), ledgerRepo: ledger.repo, ledgerLoader: ledger.loader,
      initialLedgerHeadEntryId: 4n, renderEvent: renderBotEvent, eventDebounceMs: 0,
      compactOptions: {
        reserveTokens: 20,
        keepRecentTokens: 1,
        summarizeCandidate: async () => validLedgerSummary(),
      },
    })

    await agent.runOnceForTest()

    assert.equal(llmCalls, 2)
    assert.equal(ledger.compactionCalls.length, 1)
    assert.ok(ledger.checkpointAttempts() >= 1)
    assert.match((ctx.getSnapshot().messages[0] as { content: string }).content, /^\[历史摘要\]/)
  })

  test('head race discards the candidate and recalculates against the new canonical head', async () => {
    const seed = ['old-a', 'old-b', 'old-c', 'recent'].map((content) => ({
      role: 'user' as const,
      content,
    }))
    const ctx = createAgentContext({ initialMessages: seed })
    const ledger = makeCanonicalCompactionHarness(seed, { headRaceOnce: true })
    let summaries = 0
    const agent = createBotLoopAgent({
      systemPrompt: '', context: ctx, eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '', toolCalls: [], usage: { inputTokens: 91, cachedTokens: 0, outputTokens: 0 },
        model: 'mock', contextWindowTokens: 100, stopReason: 'end_turn',
      }]),
      tools: makeMockTools(), ledgerRepo: ledger.repo, ledgerLoader: ledger.loader,
      initialLedgerHeadEntryId: 4n, renderEvent: renderBotEvent, eventDebounceMs: 0,
      compactOptions: {
        reserveTokens: 20,
        keepRecentTokens: 1,
        summarizeCandidate: async () => { summaries++; return validLedgerSummary() },
      },
    })

    await agent.runOnceForTest()

    assert.equal(ledger.compactionCalls.length, 2)
    assert.equal(summaries, 2)
    assert.equal(ledger.compactionCalls[1]?.expectedHeadEntryId, 5n)
    assert.equal(ctx.getSnapshot().messages.at(-1)?.content, 'concurrent message')
  })

  test('commits assistant tool calls and every ordered tool result as one batch', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('run both')
    const ledger = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const calls = [
      { id: 'lookup-a', name: 'lookup', args: { value: 'a' } },
      { id: 'lookup-b', name: 'lookup', args: { value: 'b' } },
    ]
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: calls,
        usage: { inputTokens: 4, cachedTokens: 0, outputTokens: 3 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools({ lookup: async () => ({ content: '{"ok":true}' }) }),
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.equal(ledger.appendCalls.length, 1)
    assert.deepEqual(ledger.appendCalls[0]?.messages, [
      { role: 'assistant', content: '', toolCalls: calls },
      { role: 'tool', toolCallId: 'lookup-a', content: '{"ok":true}' },
      { role: 'tool', toolCallId: 'lookup-b', content: '{"ok":true}' },
    ])
    assert.deepEqual(ctx.getSnapshot().messages.slice(1), ledger.appendCalls[0]?.messages)
  })

  test('commits mailbox notification disclosure without marking message bodies as read', async () => {
    const ctx = createAgentContext()
    const queue = new InMemoryEventQueue<BotEvent>()
    queue.enqueue({
      type: 'napcat_private_message',
      messageRowId: 31,
      peerId: 9001,
      messageId: 20_031,
      senderId: 9001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date('2026-07-15T00:00:00.000Z'),
      renderedText: 'hello',
    })
    const ledger = makeMockLedgerHarness([], { failAppend: true })
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: queue,
      llm: makeMockLlm([]),
      tools: makeMockTools(),
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await assert.rejects(agent.runOnceForTest(), /ledger commit failed/)

    assert.equal(ledger.appendCalls.length, 1)
    assert.match(
      ledger.appendCalls[0]?.messages[0]?.role === 'user'
        ? ledger.appendCalls[0].messages[0].content
        : '',
      /"mailbox":"qq_private:9001"/,
    )
    assert.deepEqual(ledger.appendCalls[0]?.runtimePatch?.mailboxCursors, {
      'qq_private:9001': 31,
    })
    assert.equal(ledger.appendCalls[0]?.runtimePatch?.inboxReadCursors, undefined)
    assert.deepEqual(ctx.getSnapshot().messages, [])
    assert.equal(queue.size(), 1, 'failed disclosure must remain retryable')
  })

  test('appends and persists a handled marker after a confirmed private send', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const { repo, loader, saved } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'send-1', name: 'send_message', args: { text: '收到' } }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools({
        send_message: async () => ({
          content: '{"ok":true,"status":"sent"}',
          effects: [{ type: 'message_sent', target: { type: 'private', userId: 9001 } }],
        }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const marker = '{"event":"mailbox_handled","mailbox":"qq_private:9001","throughRowId":88}'
    assert.deepEqual(ctx.getSnapshot().messages.at(-1), { role: 'user', content: marker })
    assert.deepEqual(saved.at(-1)?.messages.at(-1), { role: 'user', content: marker })
  })

  test('persists the handled marker before active goal accounting can fail', async () => {
    const baseGoalStore = createInMemoryGoalStore()
    const created = await baseGoalStore.createSelf({
      objective: '完成当前回复',
      motivation: '处理 owner 的新消息',
      completionCriteria: ['成功回复并保存处理状态'],
      currentCommitment: {
        action: '回复当前注意消息',
        reason: '这是当前目标的立即步骤',
        expectedEvidence: '发送成功并保存 handled marker',
      },
    })
    assert.ok(created.goal)
    const goalStore = {
      ...baseGoalStore,
      async accountRound(): Promise<never> {
        throw new Error('goal accounting failed')
      },
    }
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const { repo, loader, saved } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'send-1', name: 'send_message', args: { text: '收到' } }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools({
        send_message: async () => ({
          content: '{"ok":true,"status":"sent"}',
          effects: [{ type: 'message_sent', target: { type: 'private', userId: 9001 } }],
        }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      goalStore,
      initialGoalRevision: created.goal.revision,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await assert.rejects(() => agent.runOnceForTest(), /goal accounting failed/)

    const savedMessages = saved.at(-1)?.messages ?? []
    assert.equal(
      savedMessages.some(
        (message) => message.role === 'tool' && message.toolCallId === 'send-1',
      ),
      true,
    )
    assert.deepEqual(savedMessages.at(-1), {
      role: 'user',
      content: '{"event":"mailbox_handled","mailbox":"qq_private:9001","throughRowId":88}',
    })
  })

  test('closes a durable inbox cursor when the confirmed send happens in a later step', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([
        {
          content: '',
          toolCalls: [{ id: 'inbox-1', name: 'inbox', args: { peerId: 9001 } }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
          contextWindowTokens: 200_000,
        },
        {
          content: '',
          toolCalls: [{ id: 'send-1', name: 'send_message', args: { text: '稍后回复' } }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
          contextWindowTokens: 200_000,
        },
      ]),
      tools: makeMockTools({
        inbox: async () => ({ content: '{"ok":true,"messages":[]}' }),
        send_message: async () => ({
          content: '{"ok":true,"status":"sent"}',
          effects: [{ type: 'message_sent', target: { type: 'private', userId: 9001 } }],
        }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()
    assert.equal(
      ctx.getSnapshot().messages.some(
        (message) => message.role === 'user' && message.content.includes('mailbox_handled'),
      ),
      false,
    )

    await agent.runOnceForTest()

    assert.deepEqual(ctx.getSnapshot().messages.at(-1), {
      role: 'user',
      content: '{"event":"mailbox_handled","mailbox":"qq_private:9001","throughRowId":88}',
    })
  })

  test('keeps an unhandled private mailbox actionable across a later no-progress tool round', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_private_message',
      messageRowId: 88,
      peerId: 9001,
      messageId: 12345,
      senderId: 9001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date('2026-07-21T14:57:35.000Z'),
      renderedText: '这些东西都可以分享，记住了吗',
    })
    let llmCallCount = 0
    let inboxCallCount = 0
    let waits = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          llmCallCount++
          return {
            content: '',
            toolCalls: llmCallCount === 1
              ? [{ id: 'inbox-private', name: 'inbox', args: { source: 'private', peerId: 9001 } }]
              : llmCallCount === 2
                ? [{ id: 'inbox-empty-group', name: 'inbox', args: { source: 'group', groupId: 99 } }]
                : [{ id: 'send-private', name: 'send_message', args: { text: '记住了' } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      tools: makeMockTools({
        inbox: async () => {
          inboxCallCount++
          return inboxCallCount === 1
            ? {
                content: '{"ok":true,"messages":[{"rowId":88}]}',
                outcome: { ok: true, code: 'observed', progress: true },
                effects: [{ type: 'inbox_read', mailbox: 'qq_private:9001', throughRowId: 88 }],
              }
            : {
                content: '{"ok":true,"messages":[]}',
                outcome: { ok: true, code: 'empty', progress: false },
              }
        },
        send_message: async () => {
          await agent.stop()
          return {
            content: '{"ok":true,"status":"sent"}',
            outcome: { ok: true, code: 'sent', progress: true },
            effects: [{ type: 'message_sent', target: { type: 'private', userId: 9001 } }],
          }
        },
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        async waitForAttentionOrTimeout() {
          waits++
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 3)
    assert.equal(waits, 0)
    assert.deepEqual(ctx.getSnapshot().messages.at(-1), {
      role: 'user',
      content: '{"event":"mailbox_handled","mailbox":"qq_private:9001","throughRowId":88}',
    })
  })

  test('does not append a handled marker when send_message has no confirmed effect', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'send-1', name: 'send_message', args: { text: '收到' } }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools({
        send_message: async () => ({ content: '{"ok":false,"status":"failed"}' }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.equal(
      ctx.getSnapshot().messages.some(
        (message) => message.role === 'user' && message.content.includes('mailbox_handled'),
      ),
      false,
    )
  })

  test('does not close a pending mailbox when the confirmed send targets another private chat', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'send-1', name: 'send_message', args: { text: '发给别人' } }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools({
        send_message: async () => ({
          content: '{"ok":true,"status":"sent"}',
          effects: [{ type: 'message_sent', target: { type: 'private', userId: 9002 } }],
        }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.equal(
      ctx.getSnapshot().messages.some(
        (message) => message.role === 'user' && message.content.includes('mailbox_handled'),
      ),
      false,
    )
  })

  test('appends one handled marker for duplicate confirmed sends to the same target in one round', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: [
          { id: 'send-1', name: 'send_message', args: { text: '第一段' } },
          { id: 'send-2', name: 'send_message', args: { text: '第二段' } },
        ],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools({
        send_message: async () => ({
          content: '{"ok":true,"status":"sent"}',
          effects: [{ type: 'message_sent', target: { type: 'private', userId: 9001 } }],
        }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const marker = '{"event":"mailbox_handled","mailbox":"qq_private:9001","throughRowId":88}'
    assert.equal(
      ctx.getSnapshot().messages.filter(
        (message) => message.role === 'user' && message.content === marker,
      ).length,
      1,
    )
  })

  test('drains mentioned group events as high-priority mailbox notifications, runs LLM, executes tools', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })

    const llm = makeMockLlm([
      {
        content: '思考',
        toolCalls: [{ id: 'c1', name: 'send_group_message', args: { text: '在' } }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
        contextWindowTokens: 200_000,
      },
    ])

    let toolExecuted = false
    const tools = makeMockTools({
      send_group_message: async () => {
        toolExecuted = true
        return { content: '{"ok":true,"status":"sent"}' }
      },
    })

    const { repo, loader, saved } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    const agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: async (event) => {
        if (event.type !== 'napcat_message') return null
        return `[${event.senderNickname}] hello`
      },
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const messages = ctx.getSnapshot().messages
    assert.equal(messages.length, 3, 'user + assistant + tool')
    assert.equal(messages[0]?.role, 'user')
    if (messages[0]?.role === 'user') {
      const notification = JSON.parse(messages[0].content)
      assert.equal(notification.data.mailbox, 'qq_group:999')
      assert.equal(notification.priority, 'high')
      assert.doesNotMatch(messages[0].content, /hello/)
    }
    assert.equal(messages[1]?.role, 'assistant')
    if (messages[1]?.role === 'assistant') {
      assert.equal(messages[1].content, '', 'new assistant text must not enter durable AgentContext')
    }
    assert.equal(messages[2]?.role, 'tool')
    assert.equal(toolExecuted, true)
    assert.equal(saved.length, 2, 'event disclosure and tool batch must commit separately')
  })

  test('adds one prior-message compensation after a durable two-hour mailbox gap', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const firstAt = new Date('2026-01-01T00:00:00Z')
    eventQueue.enqueue({
      type: 'napcat_private_message',
      messageRowId: 30,
      peerId: 9001,
      messageId: 20_030,
      senderId: 9001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date(firstAt.getTime() + MAILBOX_LIGHT_COMPENSATION_AFTER_MS),
      renderedText: 'follow up',
    })
    const continuity = createEmptyMailboxContinuityState()
    recordMailboxDisclosure(continuity, 'qq_private:9001', firstAt.getTime())
    const { repo, loader, savedContinuity } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      initialMailboxContinuity: continuity,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const notification = ctx.getSnapshot().messages[0]
    assert.equal(notification?.role, 'user')
    if (notification?.role === 'user') {
      const payload = JSON.parse(notification.content)
      assert.equal(payload.open.args.contextBefore, 1)
    }
    assert.equal(savedContinuity.at(-1)?.roundSeq, 1)
    assert.equal(savedContinuity.at(-1)?.mailboxes['qq_private:9001']?.lastMessageAtMs,
      firstAt.getTime() + MAILBOX_LIGHT_COMPENSATION_AFTER_MS)
  })

  test('wake events drain without appending to context', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'wake' })
    eventQueue.enqueue({ type: 'wake' })

    const llm = makeMockLlm([
      {
        content: '',
        toolCalls: [],
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
        contextWindowTokens: 200_000,
      },
    ])

    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: () => null,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()
    assert.equal(ctx.getSnapshot().messages.length, 0, 'wake events must not enter context')
  })



  test('context overflow forces one compaction, saves it, and retries the LLM round once', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('old-0')
    ctx.appendUserMessage('old-1')
    ctx.appendUserMessage('old-2')
    ctx.appendUserMessage('old-3')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'bootstrap' })
    let chatCalls = 0
    const llm: LlmClient = {
      async chat() {
        chatCalls += 1
        if (chatCalls === 1) {
          throw Object.assign(new Error('prompt too long'), { kind: 'context_overflow' })
        }
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 0 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }
    const { repo, loader, saved } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: {
        triggerTokens: 100_000,
        keepRecentTokens: 1,
        summarizeCandidate: async () => validLedgerSummary('recovered history'),
      },
    })

    await agent.runOnceForTest()

    assert.equal(chatCalls, 2)
    assert.equal(saved.length, 3, 'event disclosure, recovery compaction, and round result')
    const messages = ctx.getSnapshot().messages
    assert.equal(messages[0]?.role, 'user')
    if (messages[0]?.role === 'user') assert.match(messages[0].content, /^\[历史摘要\][\s\S]*recovered /)
    assert.equal(messages.some((message) => message.role === 'assistant'), false)
    assert.deepEqual(saved.at(-1), ctx.exportPersistedSnapshot())
  })

  test('context overflow recovery is bounded to one compaction attempt per round', async () => {
    const ctx = createAgentContext()
    for (let i = 0; i < 5; i += 1) ctx.appendUserMessage(`old-${i}`)
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'bootstrap' })
    let chatCalls = 0
    let summarizeCalls = 0
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          chatCalls += 1
          throw Object.assign(new Error('still too long'), { kind: 'context_overflow' })
        },
      },
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: {
        keepRecentTokens: 1,
        summarizeCandidate: async () => {
          summarizeCalls += 1
          return validLedgerSummary()
        },
      },
    })

    await assert.rejects(() => agent.runOnceForTest(), /still too long/)
    assert.equal(chatCalls, 2)
    assert.equal(summarizeCalls, 1)
  })

  test('context overflow preserves the provider error and context when recovery summarization fails', async () => {
    const ctx = createAgentContext()
    for (let i = 0; i < 5; i += 1) ctx.appendUserMessage(`old-${i}`)
    let beforeRecovery = ctx.getSnapshot()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'bootstrap' })
    let chatCalls = 0
    let summarizeCalls = 0
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          chatCalls++
          if (chatCalls === 1) {
            beforeRecovery = ctx.getSnapshot()
            throw Object.assign(new Error('prompt too long'), { kind: 'context_overflow' })
          }
          return {
            content: '',
            toolCalls: [],
            usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 0 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: {
        keepRecentTokens: 1,
        summarizeCandidate: async () => {
          summarizeCalls++
          throw new Error('summarizer unavailable')
        },
      },
    })

    await assert.rejects(() => agent.runOnceForTest(), /prompt too long/)
    assert.equal(chatCalls, 1)
    assert.equal(summarizeCalls, 1)
    assert.deepEqual(ctx.getSnapshot(), beforeRecovery)
  })

  test('checkpoints text-only truncated output and continues without replaying partial tool calls', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'bootstrap' })
    const seenMessages: PersistedAgentSnapshot['messages'][] = []
    let chatCalls = 0
    let toolExecutions = 0
    const llm: LlmClient = {
      async chat(input) {
        seenMessages.push(input.messages)
        chatCalls++
        if (chatCalls <= 2) {
          return {
            content: chatCalls === 1 ? 'first partial' : 'second partial',
            toolCalls: [],
            usage: { inputTokens: 10, cachedTokens: 5, outputTokens: 8 },
            model: 'mock',
            contextWindowTokens: 200_000,
            stopReason: 'max_tokens',
          }
        }
        return {
          content: '',
          toolCalls: [{ id: 'done-1', name: 'done', args: {} }],
          usage: { inputTokens: 12, cachedTokens: 6, outputTokens: 2 },
          model: 'mock',
          contextWindowTokens: 200_000,
          stopReason: 'tool_use',
        }
      },
    }
    const { repo, loader, saved } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools({
        done: async () => {
          toolExecutions++
          return { content: '{"ok":true}' }
        },
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.equal(chatCalls, 3)
    assert.equal(toolExecutions, 1)
    assert.equal(saved.length, 2, 'event disclosure and the complete continued round are committed')
    assert.equal(
      seenMessages[2]?.some(
        (message) => message.role === 'assistant' && message.content === 'second partial',
      ),
      true,
    )
    const messages = ctx.getSnapshot().messages
    const partial = messages.find(
      (message) => message.role === 'assistant' && message.content === 'second partial',
    )
    assert.ok(partial)
    assert.equal(
      messages.some(
        (message) => message.role === 'assistant' && message.content === 'first partial',
      ),
      false,
      'the first same-request retry is not durable',
    )
    assert.equal(messages.at(-1)?.role, 'tool')
  })



  test('replaces ambient group bodies with metadata notification and persists source cursors', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 41,
      groupId: 999,
      groupName: '环境群',
      messageId: 12341,
      senderId: 100,
      senderNickname: '路人甲',
      mentionedSelf: false,
      sentAt: new Date('2026-07-03T00:00:00Z'),
      renderedText: 'AMBIENT_BODY_MUST_NOT_ENTER_CONTEXT',
    })
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 43,
      groupId: 999,
      groupName: '环境群',
      messageId: 12343,
      senderId: 101,
      senderNickname: '路人乙',
      mentionedSelf: false,
      sentAt: new Date('2026-07-03T00:00:01Z'),
      renderedText: 'SECOND_AMBIENT_BODY_MUST_NOT_ENTER_CONTEXT',
    })

    const llm = makeMockLlm([{
      content: '',
      toolCalls: [],
      usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
      model: 'mock',
      contextWindowTokens: 200_000,
    }])
    const { repo, loader, savedCursors } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: (event) => event.type === 'napcat_message' ? event.renderedText : null,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(userMessages.length, 1)
    const notification = JSON.parse(userMessages[0]!.content)
    assert.equal(notification.data.qqSource.groupName, '环境群')
    assert.equal(notification.count, 2)
    assert.doesNotMatch(userMessages[0]!.content, /AMBIENT_BODY/)
    assert.deepEqual(savedCursors, [
      { 'qq_group:999': 43 },
      { 'qq_group:999': 43 },
    ])
  })

  test('replaces private bodies with one metadata notification per peer and persists cursors', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const enqueuePrivate = (rowId: number, peerId: number, text: string) => {
      eventQueue.enqueue({
        type: 'napcat_private_message',
        messageRowId: rowId,
        peerId,
        messageId: 20_000 + rowId,
        senderId: peerId,
        senderNickname: peerId === 9001 ? 'Alice' : 'Bob',
        mentionedSelf: true,
        sentAt: new Date(`2026-07-03T00:02:${String(rowId).padStart(2, '0')}Z`),
        renderedText: text,
      })
    }
    enqueuePrivate(51, 9001, 'PRIVATE_ONE')
    enqueuePrivate(52, 9002, 'PRIVATE_OTHER')
    enqueuePrivate(53, 9001, 'PRIVATE_TWO')

    const llm = makeMockLlm([{
      content: '',
      toolCalls: [],
      usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
      model: 'mock',
      contextWindowTokens: 200_000,
    }])
    const { repo, loader, savedCursors } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: (event) => event.type === 'napcat_private_message' ? event.renderedText : null,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(userMessages.length, 2)
    assert.deepEqual(userMessages.map((message) => JSON.parse(message.content).data.mailbox), [
      'qq_private:9001',
      'qq_private:9002',
    ])
    assert.doesNotMatch(userMessages.map((message) => message.content).join('\n'), /PRIVATE_/)
    assert.deepEqual(savedCursors.at(-1), {
      'qq_private:9001': 53,
      'qq_private:9002': 52,
    })
  })

  test('appends backlog metadata events and advances their source cursor', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'mailbox_backlog',
      mailboxKey: 'qq_group:999',
      priority: 'normal',
      source: { type: 'group', groupId: 999, groupName: '积压群' },
      count: 230,
      firstRowId: 1_000,
      throughRowId: 1_500,
      recentAfterRowId: 1_430,
      senderCount: 12,
      timeRange: {
        from: new Date('2026-07-03T00:00:00Z'),
        to: new Date('2026-07-03T02:00:00Z'),
      },
    })

    const { repo, loader, savedCursors } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(userMessages.length, 1)
    const notification = JSON.parse(userMessages[0]!.content)
    assert.equal(notification.data.mode, 'backlog')
    assert.equal(notification.data.mailbox, 'qq_group:999')
    assert.equal(notification.data.throughRowId, 1_500)
    assert.deepEqual(notification.data.latestReadArgs, {
      action: 'read',
      source: 'group',
      groupId: 999,
      afterRowId: 1_430,
      limit: 50,
    })
    assert.deepEqual(savedCursors, [
      { 'qq_group:999': 1_500 },
      { 'qq_group:999': 1_500 },
    ])
  })

  test('preserves the restored legacy wake boundary across non-message rounds', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'bootstrap' })
    const restoredWakeAt = new Date('2026-07-02T12:00:00Z')
    const { repo, loader, savedLastWakeAt } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      initialLastWakeAt: restoredWakeAt,
      renderEvent: () => '[好奇心 tick]',
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.deepEqual(savedLastWakeAt, [restoredWakeAt, restoredWakeAt])
  })

  test('does not rerun the LLM when a redelivered message is already behind its source cursor', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('existing durable history')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 10,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: 'duplicate',
      mentionedSelf: true,
      sentAt: new Date('2026-07-03T00:00:00Z'),
      renderedText: 'must be ignored',
    })
    let llmCalled = false
    const { repo, loader, saved } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          llmCalled = true
          throw new Error('LLM must not run for cursor-filtered redelivery')
        },
      },
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      initialMailboxCursors: { 'qq_group:999': 10 },
      renderEvent: () => 'must not render',
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.equal(llmCalled, false)
    assert.equal(saved.length, 0)
    assert.deepEqual(ctx.getSnapshot().messages, [{ role: 'user', content: 'existing durable history' }])
  })

  test('空队列等待外部事件时只保活进程, 不注入空闲事件', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const llm: LlmClient = {
      async chat() {
        throw new Error('LLM should not run while there are no events')
      },
    }
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    let opened = 0
    let closed = 0

    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: () => null,
      eventDebounceMs: 0,
      keepAlive: {
        open() {
          opened++
          return {
            close() {
              closed++
            },
          }
        },
      },
    })

    const startPromise = agent.start()
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(opened, 1)
    assert.equal(closed, 0)
    assert.equal(eventQueue.size(), 0, 'waiting must not enqueue wake/idle events')
    assert.equal(ctx.getSnapshot().messages.length, 0)

    await agent.stop()
    await startPromise

    assert.equal(closed, 1)
  })

  test('LLM call 非 send_message tool 后立即跑下一轮消化 result', async () => {
    // 双轮意图: round 1 LLM call reddit → tool result 进 context → 主循环立即跑 round 2 →
    // LLM 看到 result 决定 send_message → 真发出去. 但 send_message 之后不再继续空转,
    // 避免同一批入站消息被重复回复.
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })

    let llmCallCount = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 1) {
          return {
            content: '让我看看 reddit 有啥',
            toolCalls: [{ id: 'c1', name: 'reddit', args: { action: 'list', subreddit: 'technology' } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        }
        if (llmCallCount === 2) {
          return {
            content: '看到了, 分享一下',
            toolCalls: [{ id: 'c2', name: 'send_message', args: {} }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        }
        // 如果 send_message 后仍继续跑, 这里会 stop; 正常情况下不会走到这里.
        return {
          content: '',
          toolCalls: [{ id: 'c3', name: 'rest', args: { durationSeconds: 30 } }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }

    let sendMessageCalled = false
    const tools = makeMockTools({
      reddit: async () => ({ content: '{"source":"reddit","result":"foo bar"}' }),
      send_message: async () => {
        sendMessageCalled = true
        return { content: '{"ok":true,"status":"sent"}' }
      },
      rest: async () => {
        await agent.stop()
        return { content: '{"ok":true,"status":"elapsed"}' }
      },
    })
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: async (event) => {
        if (event.type !== 'napcat_message') return null
        return `[${event.senderNickname}] hello`
      },
      eventDebounceMs: 0,
    })

    const startPromise = agent.start()
    await new Promise((resolve) => setTimeout(resolve, 100))

    // 双轮意图贯通: LLM 至少跑了 2 次, send_message 真的执行了
    assert.ok(llmCallCount >= 2, `expected LLM ≥2 calls, got ${llmCallCount}`)
    assert.equal(sendMessageCalled, true, 'send_message 拿到 reddit result 后真发出去了')
    await agent.stop()

    await startPromise
  })

  test('send_message 成功后可以在下一轮用 yield 交回控制权', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })

    let llmCallCount = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'c1', name: 'send_message', args: { text: '在' } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        }
        return {
          content: '',
          toolCalls: [{
            id: 'c2',
            name: 'yield',
            args: { reason: '当前没有待处理行动' },
          }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }

    let sendMessageCount = 0
    let yielded = false
    const tools = makeMockTools({
      send_message: async () => {
        sendMessageCount++
        return { content: '{"ok":true,"status":"sent"}' }
      },
      yield: async () => {
        yielded = true
        await agent.stop()
        return {
          content: '{"ok":true,"status":"yielded"}',
          outcome: { ok: true, code: 'yielded', progress: false, continuation: 'stop' },
        }
      },
    })
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: async (event) => {
        if (event.type !== 'napcat_message') return null
        return `[${event.senderNickname}] hello`
      },
      eventDebounceMs: 0,
    })

    const startPromise = agent.start()
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(llmCallCount, 2, 'send_message 只是动作, 成功后仍应由 Agent 选择下一步')
      assert.equal(sendMessageCount, 1)
      assert.equal(yielded, true)
    } finally {
      await agent.stop()
      await startPromise
    }
  })

  test('discloses high-priority QQ notification before an earlier scheduled wake', async () => {
    const goalStore = createInMemoryGoalStore()
    const created = await goalStore.createSelf({
      objective: '完成当前研究',
      motivation: '把已有主线做完',
      completionCriteria: ['得到可验证的结论'],
      currentCommitment: TEST_GOAL_COMMITMENT,
    })
    assert.ok(created.goal)
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue(makeScheduledWake())
    eventQueue.enqueue({
      type: 'napcat_private_message',
      messageRowId: 88,
      peerId: 9001,
      messageId: 20_088,
      senderId: 9001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date('2026-07-13T09:00:01.000Z'),
      renderedText: '在吗',
    })
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      goalStore,
      initialGoalRevision: created.goal.revision,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(JSON.parse(userMessages[0]!.content).priority, 'high')
    assert.equal(JSON.parse(userMessages[1]!.content).kind, 'schedule_due')
    assert.equal(JSON.parse(userMessages[2]!.content).event, 'goal_continuation')
  })

  test('keeps mailbox continuity at the newest message after priority reordering', async () => {
    const oldAt = new Date('2026-07-13T06:00:00.000Z')
    const highAt = new Date('2026-07-13T09:00:00.000Z')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'mailbox_backlog',
      mailboxKey: 'qq_group:999',
      priority: 'normal',
      source: { type: 'group', groupId: 999, groupName: '环境群' },
      count: 100,
      firstRowId: 1,
      throughRowId: 100,
      recentAfterRowId: 50,
      senderCount: 10,
      timeRange: { from: new Date(oldAt.getTime() - 60_000), to: oldAt },
    })
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 101,
      groupId: 999,
      groupName: '环境群',
      messageId: 20_101,
      senderId: 9001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: highAt,
      renderedText: '@bot 新消息',
    })
    const ctx = createAgentContext()
    const { repo, loader, savedContinuity } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([
        {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
          model: 'mock',
          contextWindowTokens: 200_000,
        },
        {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 20, cachedTokens: 0, outputTokens: 0 },
          model: 'mock',
          contextWindowTokens: 200_000,
        },
      ]),
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()
    const continuityAfterReordering = structuredClone(savedContinuity.at(-1))

    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 102,
      groupId: 999,
      groupName: '环境群',
      messageId: 20_102,
      senderId: 9002,
      senderNickname: 'Bob',
      mentionedSelf: false,
      sentAt: new Date(highAt.getTime() + 1_000),
      renderedText: '紧邻消息',
    })
    await agent.runOnceForTest()

    const notifications = ctx.getSnapshot().messages
      .filter((message) => message.role === 'user')
      .map((message) => JSON.parse(message.content) as {
        priority?: string
        data?: {
          mode?: string
          throughRowId?: number
          readArgs?: { contextBefore?: number }
        }
      })
    assert.equal(notifications[0]?.priority, 'high')
    assert.equal(notifications[0]?.data?.throughRowId, 101)
    assert.equal(notifications[1]?.data?.mode, 'backlog')
    assert.equal(continuityAfterReordering?.mailboxes['qq_group:999']?.lastMessageAtMs, highAt.getTime())
    assert.equal(notifications[2]?.data?.throughRowId, 102)
    assert.equal(notifications[2]?.data?.readArgs?.contextBefore, undefined)
  })

  test('sorts high backlog and mentioned group batches before a scheduled wake', async () => {
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue(makeScheduledWake())
    eventQueue.enqueue({
      type: 'mailbox_backlog',
      mailboxKey: 'qq_private:9001',
      priority: 'high',
      source: { type: 'private', peerId: 9001, senderName: 'Alice' },
      count: 100,
      firstRowId: 1,
      throughRowId: 100,
      recentAfterRowId: 50,
      senderCount: 1,
      timeRange: {
        from: new Date('2026-07-13T08:00:00.000Z'),
        to: new Date('2026-07-13T08:30:00.000Z'),
      },
    })
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 101,
      groupId: 999,
      groupName: '环境群',
      messageId: 20_101,
      senderId: 9002,
      senderNickname: 'Bob',
      mentionedSelf: true,
      sentAt: new Date('2026-07-13T09:00:00.000Z'),
      renderedText: '@bot 新消息',
    })
    const ctx = createAgentContext()
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(JSON.parse(userMessages[0]!.content).data.mode, 'backlog')
    assert.equal(JSON.parse(userMessages[0]!.content).priority, 'high')
    assert.equal(JSON.parse(userMessages[1]!.content).priority, 'high')
    assert.equal(JSON.parse(userMessages[1]!.content).data.throughRowId, 101)
    assert.equal(JSON.parse(userMessages[2]!.content).kind, 'schedule_due')
  })

  test('discloses scheduled wake before the active goal continuation', async () => {
    const goalStore = createInMemoryGoalStore()
    const created = await goalStore.createSelf({
      objective: '完成当前研究',
      motivation: '把已有主线做完',
      completionCriteria: ['得到可验证的结论'],
      currentCommitment: TEST_GOAL_COMMITMENT,
    })
    assert.ok(created.goal)
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue(makeScheduledWake())
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      goalStore,
      initialGoalRevision: created.goal.revision,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(JSON.parse(userMessages[0]!.content).kind, 'schedule_due')
    assert.equal(JSON.parse(userMessages[1]!.content).event, 'goal_continuation')
  })

  test('discloses active goal continuation before an ambient mailbox notification', async () => {
    const goalStore = createInMemoryGoalStore()
    const created = await goalStore.createSelf({
      objective: '完成当前研究',
      motivation: '把已有主线做完',
      completionCriteria: ['得到可验证的结论'],
      currentCommitment: TEST_GOAL_COMMITMENT,
    })
    assert.ok(created.goal)
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 89,
      groupId: 999,
      groupName: '环境群',
      messageId: 20_089,
      senderId: 9002,
      senderNickname: 'Bob',
      mentionedSelf: false,
      sentAt: new Date('2026-07-13T09:00:01.000Z'),
      renderedText: '普通群消息',
    })
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      goalStore,
      initialGoalRevision: created.goal.revision,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(JSON.parse(userMessages[0]!.content).event, 'goal_continuation')
    assert.equal(JSON.parse(userMessages[1]!.content).priority, 'normal')
  })

  test('delegates tool execution failures to the React kernel durable error result path', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'bootstrap' })
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'boom-1', name: 'boom', args: {} }],
        usage: { inputTokens: 4, cachedTokens: 0, outputTokens: 3 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools({
        boom: async () => {
          throw new Error('kernel catches this')
        },
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const toolMessage = ctx.getSnapshot().messages.find((message) => message.role === 'tool')
    assert.equal(toolMessage?.role, 'tool')
    if (toolMessage?.role === 'tool') {
      assert.equal(toolMessage.toolCallId, 'boom-1')
      assert.equal(typeof toolMessage.content, 'string')
      const content = JSON.parse(toolMessage.content as string) as { code?: unknown; error?: unknown }
      assert.equal(content.code, 'execution_failed')
      const error = content.error
      if (typeof error !== 'string') {
        assert.fail('expected durable error content to include an error string')
      }
      assert.match(error, /kernel catches this/)
    }
  })

  test('persists inbox read effects atomically with the visible tool result', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'bootstrap' })
    const ledger = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'inbox-1', name: 'inbox', args: { action: 'read' } }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }]),
      tools: makeMockTools({
        inbox: async () => ({
          content: '{"ok":true,"messages":[{"rowId":42}]}',
          effects: [{ type: 'inbox_read', mailbox: 'qq_group:123', throughRowId: 42 }],
        }),
      }),
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.deepEqual(ledger.appendCalls.at(-1)?.runtimePatch?.inboxReadCursors, {
      'qq_group:123': 42,
    })
    assert.equal(ctx.getSnapshot().messages.at(-1)?.role, 'tool')
  })

  test('send_message 非 sent 状态即使 ok=true 也立即跑下一轮让 LLM 修正', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })

    let llmCallCount = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'c1', name: 'send_message', args: { text: '在' } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        }
        return {
          content: '',
          toolCalls: [{ id: 'c2', name: 'rest', args: { durationSeconds: 30 } }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }

    let restCalled = false
    const tools = makeMockTools({
      send_message: async () => ({ content: '{"ok":true,"status":"rejected","error":"not allowed"}' }),
      rest: async () => {
        restCalled = true
        await agent.stop()
        return { content: '{"ok":true,"status":"elapsed"}' }
      },
    })
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: async (event) => {
        if (event.type !== 'napcat_message') return null
        return `[${event.senderNickname}] hello`
      },
      eventDebounceMs: 0,
    })

    const startPromise = agent.start()
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.ok(llmCallCount >= 2, `expected LLM to see rejected send result, got ${llmCallCount}`)
      assert.equal(restCalled, true)
    } finally {
      await agent.stop()
      await startPromise
    }
  })

  test('高 token 使用不触发跨日限流，连续进展超过 20 轮也不强制冷却', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'bootstrap' })
    let llmCallCount = 0
    let waits = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 25) await agent.stop()
        return {
          content: '',
          toolCalls: [{ id: `lookup-${llmCallCount}`, name: 'lookup', args: {} }],
          usage: { inputTokens: 500_000, cachedTokens: 0, outputTokens: 500_000 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools({
        lookup: async () => ({ content: '{"ok":true}' }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        async waitForAttentionOrTimeout() {
          waits++
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 25)
    assert.equal(waits, 0)
  })


  test('continuation=immediate 立即进入有界纠错', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'bootstrap' })
    let llmCallCount = 0
    let waits = 0
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        return {
          content: '',
          toolCalls: llmCallCount === 1
            ? [{ id: 'bad-evidence', name: 'lookup', args: {} }]
            : [{ id: 'yield-after-correction', name: 'yield', args: {} }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    const agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools({
        lookup: async () => ({
          content: '{"ok":false,"code":"invalid_evidence"}',
          outcome: {
            ok: false,
            code: 'invalid_evidence',
            progress: false,
            continuation: 'immediate',
          },
        }),
        yield: async () => ({
          content: '{"status":"yielded"}',
          outcome: { ok: true, code: 'yielded', progress: false, continuation: 'stop' },
        }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        async waitForAttentionOrTimeout() {
          waits++
          return 'elapsed'
        },
      },
    })

    await agent.runOnceForTest()
    await agent.runOnceForTest()

    assert.equal(llmCallCount, 2)
    assert.equal(waits, 0)
  })

  test('free no-tool round enters a 15-minute attention-interruptible wait', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('已有上下文')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'bootstrap' })
    let llmCallCount = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        async waitForAttentionOrTimeout(_queue, timeoutMs) {
          assert.equal(timeoutMs, 15 * 60_000)
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()
    assert.equal(llmCallCount, 1)
  })

  test('repeated unanchored idle rounds back off exponentially up to a bounded maximum', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('已有上下文')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'bootstrap' })
    const waits: number[] = []
    let agent: ReturnType<typeof createBotLoopAgent>
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          return {
            content: '',
            toolCalls: [],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        idleWaitMs: 100,
        maxIdleWaitMs: 400,
        async waitForAttentionOrTimeout(_queue, timeoutMs) {
          waits.push(timeoutMs)
          if (waits.length === 4) await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()
    assert.deepEqual(waits, [100, 200, 400, 400])
  })

  test('successful no-progress tool call waits instead of immediately rerunning', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('已有上下文')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    let llmCallCount = 0
    let toolCallCount = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          llmCallCount++
          return {
            content: '',
            toolCalls: [{ id: `lookup-${llmCallCount}`, name: 'lookup', args: { action: 'update', items: [] } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      tools: makeMockTools({
        lookup: async () => {
          toolCallCount++
          return {
            content: '{"ok":true,"status":"unchanged","changed":false}',
            outcome: { ok: true, code: 'unchanged', progress: false },
          }
        },
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        async waitForAttentionOrTimeout(_queue, timeoutMs) {
          assert.equal(timeoutMs, 15 * 60_000)
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 1)
    assert.equal(toolCallCount, 1)
  })

  test('send_message continue keeps the next no-progress round on the short retry wait', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('已有上下文')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    let llmCallCount = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          llmCallCount++
          return {
            content: '',
            toolCalls: llmCallCount === 1
              ? [{
                  id: 'send-continue',
                  name: 'send_message',
                  args: { message: '我先看清楚结构，马上继续。', work: { state: 'continue' } },
                }]
              : [{ id: 'lookup-empty', name: 'lookup', args: { action: 'list' } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      tools: makeMockTools({
        send_message: async () => ({
          content: '{"ok":true,"status":"sent"}',
          effects: [{
            type: 'message_sent',
            target: { type: 'private', userId: 9001 },
            continueWork: true,
          }],
          outcome: { ok: true, progress: true },
        }),
        lookup: async () => ({
          content: '{"ok":true,"items":[]}',
          outcome: {
            ok: true,
            progress: false,
            continuation: 'wait_attention',
            noveltyKey: 'lookup:0',
          },
        }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        async waitForAttentionOrTimeout(_queue, timeoutMs) {
          assert.equal(timeoutMs, 60_000)
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 2)
  })

  test('background event wait does not poll an actionable private request and publishes its reason', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const phases: Array<Parameters<AgentActivityReporter['setPhase']>[0]> = []
    let llmCallCount = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          llmCallCount++
          return {
            content: '',
            toolCalls: [{ id: 'start-research', name: 'trading_agent', args: { action: 'start' } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      tools: makeMockTools({
        trading_agent: async () => ({
          content: '{"ok":true,"status":"started","taskId":"bg-1"}',
          outcome: {
            ok: true,
            code: 'started',
            progress: true,
            continuation: 'wait_event',
            continuationDetail: '后台任务“SOL 研究”正在运行，等待完成通知',
            noveltyKey: 'background-task:bg-1:running',
          },
        }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      activityReporter: {
        setTrigger() {},
        setPhase(phase) { phases.push(phase) },
        toolStarted() {},
        toolFinished() {},
        async flush() {},
      },
      autonomy: {
        async waitForAttentionOrTimeout(_queue, timeoutMs) {
          assert.equal(timeoutMs, 15 * 60_000)
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 1)
    assert.equal([...phases].reverse().find(phase => phase.phase === 'waiting')?.detail,
      '后台任务“SOL 研究”正在运行，等待完成通知')
  })

  test('pending private attention gets one immediate no-progress correction before a bounded wait', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    let llmCallCount = 0
    let waits = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          llmCallCount++
          return {
            content: '',
            toolCalls: [{ id: `empty-${llmCallCount}`, name: 'inbox', args: { source: 'group', groupId: 99 } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      tools: makeMockTools({
        inbox: async () => ({
          content: '{"ok":true,"messages":[]}',
          outcome: { ok: true, code: 'empty', progress: false },
        }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        async waitForAttentionOrTimeout(_queue, timeoutMs) {
          waits++
          assert.equal(timeoutMs, 60_000)
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 2)
    assert.equal(waits, 1)
  })

  test('successful meta lookup can request one immediate decision round without claiming progress', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('已有上下文')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    let llmCallCount = 0
    let waits = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          llmCallCount++
          return {
            content: '',
            toolCalls: llmCallCount === 1
              ? [{ id: 'goal-get-1', name: 'goal', args: { action: 'get' } }]
              : [],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      tools: makeMockTools({
        goal: async () => ({
          content: '{"ok":true,"goal":null}',
          outcome: {
            ok: true,
            progress: false,
            continuation: 'immediate',
            noveltyKey: 'goal:none',
          },
        }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        async waitForAttentionOrTimeout() {
          waits++
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 2)
    assert.equal(waits, 1)
  })



  test('repeated novelty key suppresses immediate continuation and enters bounded wait', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('已有上下文')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    let llmCallCount = 0
    let waits = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          llmCallCount++
          if (llmCallCount === 3) await agent.stop()
          return {
            content: '',
            toolCalls: [{ id: `skill-list-${llmCallCount}`, name: 'skill', args: { action: 'list' } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      tools: makeMockTools({
        skill: async () => ({
          content: '{"ok":true,"skills":[]}',
          outcome: {
            ok: true,
            progress: false,
            continuation: 'immediate',
            noveltyKey: 'skill_catalog:empty',
          },
        }),
      }),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        async waitForAttentionOrTimeout() {
          waits++
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 2)
    assert.equal(waits, 1)
  })

  test('attention with no tool retries immediately once, then waits 60 seconds', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: '在吗',
    })
    let llmCallCount = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        async waitForAttentionOrTimeout(_queue, timeoutMs) {
          assert.equal(timeoutMs, 60_000)
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()
    assert.equal(llmCallCount, 2)
  })

  test('assistant text-only 结束会写入受控纠错并立即重试工具行动', async () => {
    const ctx = createAgentContext({
      initialMessages: [{ role: 'user', content: '已有上下文，当前没有 pending mailbox' }],
    })
    const eventQueue = new InMemoryEventQueue<BotEvent>()

    let llmCallCount = 0
    let restCalled = false
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat(input) {
        llmCallCount++
        if (llmCallCount === 1) {
          return {
            content: '先想一下',
            toolCalls: [],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        }
        const correction = input.messages.at(-1)?.content
        assert.equal(typeof correction, 'string')
        assert.match(
          correction as string,
          /"event":"runtime_correction".*"code":"assistant_text_without_tool"/,
        )
        await agent.stop()
        return {
          content: '',
          toolCalls: [{ id: 'c2', name: 'rest', args: { durationSeconds: 30 } }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
          contextWindowTokens: 200_000,
        }
      },
    }

    const tools = makeMockTools({
      rest: async () => {
        restCalled = true
        return { content: '{"ok":true,"status":"elapsed"}' }
      },
    })
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: () => null,
      eventDebounceMs: 0,
    })

    await agent.start()

    assert.equal(llmCallCount, 2)
    assert.equal(restCalled, true)
    assert.equal(
      ctx.getSnapshot().messages.some((msg) => msg.role === 'assistant' && msg.content === '先想一下'),
      false,
      'text-only assistant output is transient telemetry, not durable context',
    )
    assert.equal(
      ctx.getSnapshot().messages.some((msg) => (
        msg.role === 'user' && msg.content.includes('assistant_text_without_tool')
      )),
      true,
    )
  })

  test('连续 assistant text-only 结束只立即纠错一次，第二次进入一分钟有界等待', async () => {
    const ctx = createAgentContext({
      initialMessages: [{ role: 'user', content: '已有上下文' }],
    })
    const waits: number[] = []
    let agent: ReturnType<typeof createBotLoopAgent>
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)
    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: {
        async chat() {
          return {
            content: '我稍后会继续。',
            toolCalls: [],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: () => null,
      eventDebounceMs: 0,
      autonomy: {
        async waitForAttentionOrTimeout(_queue, timeoutMs) {
          waits.push(timeoutMs)
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()
    assert.deepEqual(waits, [60_000])
  })

  test('send_message 参数不做隐藏思考 preflight 拦截', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })

    const llm = makeMockLlm([
      {
        content: '',
        toolCalls: [{
          id: 'c1',
          name: 'send_message',
          args: {
            target: { type: 'private', userId: 10001 },
            mode: 'ambient',
            text: '收到。\n\n*思考: 这段不能进长期上下文。*',
            replyToMessageId: null,
            imageRef: null,
          },
        }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
        contextWindowTokens: 200_000,
      },
    ])

    let toolExecuted = false
    const tools = makeMockTools({
      send_message: async () => {
        toolExecuted = true
        return { content: '{"ok":true,"status":"sent"}' }
      },
    })
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    const agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: async (event) => {
        if (event.type !== 'napcat_message') return null
        return `[${event.senderNickname}] hello`
      },
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const messages = ctx.getSnapshot().messages
    assert.equal(toolExecuted, true)

    const assistant = messages.find((msg) => msg.role === 'assistant')
    assert.equal(assistant?.role, 'assistant')
    if (assistant?.role === 'assistant') {
      assert.equal(assistant.toolCalls[0]?.args.text, '收到。\n\n*思考: 这段不能进长期上下文。*')
    }

    const toolResult = messages.find((msg) => msg.role === 'tool')
    assert.equal(toolResult?.role, 'tool')
    if (toolResult?.role === 'tool' && typeof toolResult.content === 'string') {
      assert.equal(toolResult.content, '{"ok":true,"status":"sent"}')
    }
  })

  test('renderEvent returning null skips appending', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'background_task_completed',
      taskId: 'task-1',
      toolName: 'test',
      description: 'skip me',
      elapsedMs: 1,
      ok: true,
      summary: 'skip me',
    })

    const llm = makeMockLlm([
      {
        content: '',
        toolCalls: [],
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
        contextWindowTokens: 200_000,
      },
    ])
    const { repo, loader } = makeMockLedgerHarness(ctx.getSnapshot().messages)

    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      ledgerRepo: repo,
      ledgerLoader: loader,
      renderEvent: () => null,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()
    assert.equal(ctx.getSnapshot().messages.length, 0)
  })
})
