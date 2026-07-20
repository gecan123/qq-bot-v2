import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

import type { AgentMessage } from './agent-context.types.js'
import type {
  AgentLedgerEntry,
  AgentLedgerProjection,
  CompactionAgentLedgerEntry,
  MessageAgentLedgerEntry,
} from './agent-ledger.types.js'
import { AGENT_RUNTIME_STATE_SCHEMA_VERSION } from './agent-ledger.types.js'
import { estimateEntryTokens } from './compaction-token-estimator.js'
import type { LlmCallInput, LlmCallOutput, LlmClient } from './llm-client.js'
import type { Tool } from './tool.js'
import { createEmptyMailboxContinuityState } from './mailbox-continuity.js'
import {
  createCompactionCandidate,
  prepareCompaction,
  selectCompactionCacheBreakpointMessageIndex,
  summarizeCachedClaudeCompaction,
  type CompactionPreparation,
  type ReadyCompactionPreparation,
} from './compaction.js'
import {
  renderRestResumeReminder,
  shouldAppendRestResumeReminder,
} from './rest-resume-reminder.js'
import {
  captureMailboxAttentionState,
  findPendingMailboxThroughRowId,
  isMailboxAttentionStateMessage,
} from './mailbox-handled.js'

function user(content: string): AgentMessage {
  return { role: 'user', content }
}

function asst(content: string, toolCalls: { id: string; name: string }[] = []): AgentMessage {
  return {
    role: 'assistant',
    content,
    toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, args: {} })),
  }
}

function asstWithThinking(
  content: string,
  toolCalls: { id: string; name: string }[] = [],
): AgentMessage {
  return {
    role: 'assistant',
    content,
    nativeBlocks: [{ type: 'thinking', thinking: 'raw private thought', signature: 'sig' }],
    toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, args: {} })),
  }
}

function tool(toolCallId: string, content = 'ok'): AgentMessage {
  return { role: 'tool', toolCallId, content }
}

function validSummary(content = '保留了关键历史。'): string {
  return [
    '## 讨论过的话题',
    content,
    '',
    '## 群友信息',
    '',
    '## 我的承诺和状态',
    '',
    '## 工具调用结果',
    '',
    '## 情绪和氛围',
  ].join('\n')
}

function validLedgerSummary(content = '保留了关键历史。'): string {
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

const LEDGER_CREATED_AT = new Date('2026-07-15T10:00:00.000Z')

function ledgerMessage(id: bigint, message: AgentMessage): MessageAgentLedgerEntry {
  return {
    id,
    entryType: 'message',
    payload: { schemaVersion: 1, message },
    createdAt: LEDGER_CREATED_AT,
  }
}

function projection(entries: readonly AgentLedgerEntry[]): AgentLedgerProjection {
  const messages = entries
    .filter((entry) => entry.entryType === 'message')
    .map((entry) => entry.payload.message)
  return {
    throughEntryId: entries.at(-1)?.id ?? null,
    activeEntryCount: messages.length,
    permanentEntryCount: entries.length,
    snapshot: {
      schemaVersion: 4,
      messages,
      activeToolCapabilities: [],
      qqConversationFocus: null,
    },
  }
}

function prepare(input: {
  entries: readonly AgentLedgerEntry[]
  previousCompaction?: CompactionAgentLedgerEntry | null
  contextTokens?: number
  contextWindowTokens?: number
  reserveTokens?: number
  keepRecentTokens?: number
}): CompactionPreparation | null {
  return prepareCompaction({
    entries: input.entries,
    latestProjection: projection(input.entries),
    previousCompaction: input.previousCompaction ?? null,
    contextTokens: input.contextTokens ?? 81,
    contextWindowTokens: input.contextWindowTokens ?? 100,
    reserveTokens: input.reserveTokens ?? 20,
    keepRecentTokens: input.keepRecentTokens ?? 1,
    reason: 'threshold',
  })
}

function assertReady(
  result: CompactionPreparation | null,
): asserts result is ReadyCompactionPreparation {
  assert.equal(result?.status, 'ready')
}

test('selectCompactionCacheBreakpointMessageIndex returns the prefix end before recent tail', () => {
  const messages = [
    user('old turn'),
    asst('old answer'),
    user('newest turn'),
  ]

  assert.equal(selectCompactionCacheBreakpointMessageIndex(messages, 1), 1)
})

test('selectCompactionCacheBreakpointMessageIndex keeps tool call results atomic', () => {
  const messages = [
    user('old turn'),
    asst('', [{ id: 'a', name: 'lookup' }, { id: 'b', name: 'lookup' }]),
    tool('a'),
    tool('b'),
    user('newest turn'),
  ]

  assert.equal(selectCompactionCacheBreakpointMessageIndex(messages, 1), 3)
})

test('selectCompactionCacheBreakpointMessageIndex returns null without a legal cut', () => {
  const messages = [
    asst('', [{ id: 'only', name: 'lookup' }]),
    tool('only'),
  ]

  assert.equal(selectCompactionCacheBreakpointMessageIndex(messages, 1), null)
})

test('summarizeCachedClaudeCompaction appends one control message to the unchanged main prefix', async () => {
  const prefix = [user('old turn'), asst('old answer')]
  const visibleTools: Tool[] = [{
    name: 'lookup',
    description: 'lookup facts',
    schema: z.object({ query: z.string() }),
    async execute() { return { content: 'ok' } },
  }]
  const captured: LlmCallInput[] = []
  const llm: LlmClient = {
    async chat(input): Promise<LlmCallOutput> {
      captured.push(input)
      return {
        content: validLedgerSummary(),
        toolCalls: [],
        usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 20 },
        model: 'claude-test',
        contextWindowTokens: 200_000,
        stopReason: 'end_turn',
      }
    },
  }

  const result = await summarizeCachedClaudeCompaction({
    llm,
    systemPrompt: 'main system bytes',
    messages: prefix,
    tools: visibleTools,
    manualFocus: 'owner focus',
    maxSummaryTokens: 2_048,
  })

  const request = captured[0]!
  assert.equal(result, validLedgerSummary())
  assert.equal(request.systemPrompt, 'main system bytes')
  assert.deepEqual(request.messages.slice(0, -1), prefix)
  const control = request.messages.at(-1)
  assert.equal(control?.role, 'user')
  assert.match(control?.role === 'user' ? control.content : '', /owner focus/)
  assert.deepEqual(request.tools, visibleTools)
  assert.deepEqual(request.cacheBreakpointMessageIndexes, [1])
  assert.equal(request.maxOutputTokens, 2_048)
  assert.equal(request.claudeToolChoice, 'auto')
})

test('summarizeCachedClaudeCompaction rejects unsafe or incomplete completions', async () => {
  const cases: Array<{ name: string; output: Partial<LlmCallOutput> }> = [
    { name: 'tool call', output: { content: validLedgerSummary(), toolCalls: [{ id: 'x', name: 'lookup', args: {} }] } },
    { name: 'empty output', output: { content: '   ' } },
    { name: 'max tokens', output: { content: validLedgerSummary(), stopReason: 'max_tokens' } },
    { name: 'context stop', output: { content: validLedgerSummary(), stopReason: 'model_context_window_exceeded' } },
  ]

  for (const item of cases) {
    const llm: LlmClient = {
      async chat(): Promise<LlmCallOutput> {
        return {
          content: validLedgerSummary(),
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
          model: 'claude-test',
          contextWindowTokens: 200_000,
          stopReason: 'end_turn',
          ...item.output,
        }
      },
    }
    await assert.rejects(
      summarizeCachedClaudeCompaction({
        llm,
        systemPrompt: 'main system',
        messages: [user('old')],
        tools: [],
      }),
      new RegExp(item.name.replace(' ', '_')),
    )
  }

  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  let called = false
  await assert.rejects(
    summarizeCachedClaudeCompaction({
      llm: { async chat() { called = true; throw new Error('unexpected') } },
      systemPrompt: 'main system',
      messages: [user('old')],
      tools: [],
      signal: controller.signal,
    }),
    /cancelled/,
  )
  assert.equal(called, false)
})

test('prepareCompaction triggers only above context window minus reserve', () => {
  const entries = [
    ledgerMessage(1n, user('old')),
    ledgerMessage(2n, user('tail')),
  ]

  assert.equal(prepare({ entries, contextTokens: 79 }), null)
  assert.equal(prepare({ entries, contextTokens: 80 }), null)
  assert.equal(prepare({ entries, contextTokens: 81 })?.status, 'ready')
})

test('prepareCompaction accumulates from head and prefers a user-turn boundary', () => {
  const entries = [
    ledgerMessage(1n, user('old turn one')),
    ledgerMessage(2n, asst('old answer one')),
    ledgerMessage(3n, user('old turn two')),
    ledgerMessage(4n, asst('old answer two')),
    ledgerMessage(5n, user('newest turn')),
    ledgerMessage(6n, asst('newest answer')),
  ]
  const newestTurnTokens = entries.slice(4).reduce(
    (sum, entry) => sum + estimateEntryTokens(entry).tokens,
    0,
  )

  const result = prepare({ entries, keepRecentTokens: newestTurnTokens + 1 })

  assertReady(result)
  assert.equal(result.firstKeptEntryId, 3n)
  assert.equal(result.tailEntries[0]?.payload.message.role, 'user')
  assert.equal(result.isSplitTurn, false)
})

test('prepareCompaction keeps assistant tool calls and all ordered results atomically', () => {
  const entries = [
    ledgerMessage(1n, user('compress this')),
    ledgerMessage(2n, asst('', [{ id: 'a', name: 'lookup' }, { id: 'b', name: 'lookup' }])),
    ledgerMessage(3n, tool('a', '{"ok":true}')),
    ledgerMessage(4n, tool('b', '{"ok":true}')),
    ledgerMessage(5n, user('newest')),
  ]
  const keepRecentTokens = entries.slice(3).reduce(
    (sum, entry) => sum + estimateEntryTokens(entry).tokens,
    0,
  )

  const result = prepare({ entries, keepRecentTokens })

  assertReady(result)
  assert.equal(result.firstKeptEntryId, 5n)
  assert.deepEqual(result.entriesToSummarize.map((entry) => entry.id), [1n, 2n, 3n, 4n])
  assert.deepEqual(result.tailEntries.map((entry) => entry.id), [5n])
  assert.notEqual(result.tailEntries[0]?.payload.message.role, 'tool')
})

test('prepareCompaction marks an oversized latest turn split only at an atomic boundary', () => {
  const entries = [
    ledgerMessage(1n, user('old turn')),
    ledgerMessage(2n, user('latest oversized turn')),
    ledgerMessage(3n, asst('large prefix '.repeat(200))),
    ledgerMessage(4n, asst('', [{ id: 'split-call', name: 'lookup' }])),
    ledgerMessage(5n, tool('split-call', '{"ok":true}')),
    ledgerMessage(6n, asst('final action')),
  ]
  const keepRecentTokens = entries.slice(3).reduce(
    (sum, entry) => sum + estimateEntryTokens(entry).tokens,
    0,
  )

  const result = prepare({ entries, keepRecentTokens })

  assertReady(result)
  assert.equal(result.isSplitTurn, true)
  assert.equal(result.firstKeptEntryId, 4n)
  assert.deepEqual(result.tailEntries.map((entry) => entry.id), [4n, 5n, 6n])
  assert.deepEqual(result.historyEntries.map((entry) => entry.id), [1n])
  assert.deepEqual(result.splitTurnPrefixEntries.map((entry) => entry.id), [2n, 3n])
})

test('prepareCompaction repeated run summarizes only from the previous boundary forward', () => {
  const previousCompaction: CompactionAgentLedgerEntry = {
    id: 4n,
    entryType: 'compaction',
    payload: {
      schemaVersion: 1,
      summary: 'previous',
      firstKeptEntryId: '3',
      tokensBefore: 100,
      estimatedTokensAfter: 20,
      reason: 'threshold',
      isSplitTurn: false,
      previousCompactionEntryId: null,
      mailboxAttentionState: {},
      restResumeState: null,
    },
    createdAt: LEDGER_CREATED_AT,
  }
  const entries: AgentLedgerEntry[] = [
    ledgerMessage(1n, user('already summarized one')),
    ledgerMessage(2n, user('already summarized two')),
    ledgerMessage(3n, user('previous kept tail')),
    previousCompaction,
    ledgerMessage(5n, user('new one')),
    ledgerMessage(6n, user('new two')),
    ledgerMessage(7n, user('new tail')),
  ]

  const result = prepare({ entries, previousCompaction, keepRecentTokens: 1 })

  assertReady(result)
  assert.deepEqual(result.entriesToSummarize.map((entry) => entry.id), [3n, 5n, 6n])
  assert.equal(result.firstKeptEntryId, 7n)
})

test('prepareCompaction returns explicit cannot_compact when no legal atomic cut exists', () => {
  const entries = [
    ledgerMessage(1n, asst('', [{ id: 'only-call', name: 'lookup' }])),
    ledgerMessage(2n, tool('only-call', '{"ok":true}')),
  ]

  const result = prepare({ entries, keepRecentTokens: 1 })

  assert.deepEqual(result, {
    status: 'cannot_compact',
    reason: 'no_legal_cut',
    expectedHeadEntryId: 2n,
  })
})

function runtimeStateFor(entries: readonly AgentLedgerEntry[]) {
  return {
    schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
    mailboxCursors: {},
    inboxReadCursors: {},
    mailboxContinuity: createEmptyMailboxContinuityState(),
    goalRevision: 0,
    activeToolCapabilities: [],
    qqConversationFocus: null,
    lastWakeAt: null,
    ledgerHeadEntryId: entries.at(-1)?.id ?? null,
  }
}

async function createCandidate(input: Parameters<typeof createCompactionCandidate>[0]) {
  return await createCompactionCandidate(input)
}

test('createCompactionCandidate summarizes split-turn history and prefix separately', async () => {
  const entries = [
    ledgerMessage(1n, user('old turn')),
    ledgerMessage(2n, user('latest oversized turn')),
    ledgerMessage(3n, asst('large prefix '.repeat(200))),
    ledgerMessage(4n, asst('', [{ id: 'split-call', name: 'lookup' }])),
    ledgerMessage(5n, tool('split-call', '{"ok":true}')),
    ledgerMessage(6n, asst('final action')),
  ]
  const preparation = prepare({
    entries,
    keepRecentTokens: entries.slice(3).reduce(
      (sum, entry) => sum + estimateEntryTokens(entry).tokens,
      0,
    ),
  })
  assertReady(preparation)
  const kinds: string[] = []

  const result = await createCandidate({
    entries,
    runtimeState: runtimeStateFor(entries),
    preparation,
    summarize: async (request: { kind: string }) => {
      kinds.push(request.kind)
      return request.kind === 'history' ? validLedgerSummary('main history') : 'turn prefix facts'
    },
  })

  assert.equal(result.status, 'ready')
  assert.deepEqual(kinds, ['history', 'split_turn_prefix'])
  const payload = result.payload
  assert.equal(payload.isSplitTurn, true)
  assert.match(payload.summary, /main history/)
  assert.match(payload.summary, /\[单轮前缀摘要\]\nturn prefix facts\n\[\/单轮前缀摘要\]/)
})

test('createCompactionCandidate repairs an oversized summary at most once', async () => {
  const entries = [ledgerMessage(1n, user('old')), ledgerMessage(2n, user('tail'))]
  const preparation = prepare({ entries, keepRecentTokens: 1 })
  assertReady(preparation)

  const result = await createCandidate({
    entries,
    runtimeState: runtimeStateFor(entries),
    preparation,
    summarize: async () => validLedgerSummary('x'.repeat(30_000)),
    maxSummaryTokens: 400,
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.repairCount, 1)
  assert.ok(result.summaryTokens <= 400)
})

test('createCompactionCandidate validates a beforeCompact custom summary and never calls afterCompact', async () => {
  const entries = [ledgerMessage(1n, user('old')), ledgerMessage(2n, user('tail'))]
  const preparation = prepare({ entries, keepRecentTokens: 1 })
  assertReady(preparation)
  let afterCalls = 0

  const result = await createCandidate({
    entries,
    runtimeState: runtimeStateFor(entries),
    preparation,
    summarize: async () => { throw new Error('must not summarize') },
    hooks: {
      beforeCompact: async () => ({ action: 'use_summary', summary: 'invalid custom summary' }),
      afterCompact: async () => { afterCalls += 1 },
    },
  })

  assert.equal(result.status, 'invalid')
  assert.equal(result.reason, 'missing_heading:## 讨论过的话题')
  assert.equal(afterCalls, 0)
})

test('createCompactionCandidate validates the complete projected ledger', async () => {
  const entries = [
    ledgerMessage(1n, user('old')),
    ledgerMessage(2n, asst('', [{ id: 'call', name: 'lookup' }])),
    ledgerMessage(3n, tool('call', '{"ok":true}')),
    ledgerMessage(4n, user('tail')),
  ]
  const preparation = prepare({ entries, keepRecentTokens: 1 })
  assertReady(preparation)

  const result = await createCandidate({
    entries,
    runtimeState: runtimeStateFor(entries),
    preparation: { ...preparation, firstKeptEntryId: 3n },
    summarize: async () => validLedgerSummary(),
  })

  assert.equal(result.status, 'invalid')
  assert.equal(result.reason, 'candidate_projection_invalid')
})
