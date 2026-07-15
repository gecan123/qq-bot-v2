import type { AgentContext } from './agent-context.js'
import type { AgentMessage } from './agent-context.types.js'
import { createLlmClient } from './llm-client.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { recordTokenUsage } from './token-stats.js'
import { validateBotSnapshotIntegrity } from './snapshot-integrity.js'
import { SNAPSHOT_SCHEMA_VERSION } from './agent-context.types.js'
import { renderUntrustedTranscript } from './untrusted-transcript.js'
import {
  renderRestResumeReminderCompactionSuffix,
  stripRestResumeReminderCompactionSuffix,
} from './rest-resume-reminder.js'
import {
  captureMailboxAttentionState,
  isMailboxAttentionStateMessage,
  renderMailboxAttentionStateEvent,
} from './mailbox-handled.js'
import {
  AGENT_LEDGER_SCHEMA_VERSION,
  type AgentLedgerEntry,
  type AgentLedgerProjection,
  type AgentRuntimeState,
  type CompactionAgentLedgerEntry,
  type CompactionLedgerPayload,
  type CompactionReason,
  type MessageAgentLedgerEntry,
  type RestResumeCompactionState,
} from './agent-ledger.types.js'
import { estimateEntryTokens } from './compaction-token-estimator.js'
import { projectAgentLedger } from './agent-ledger-projection.js'
import {
  buildCompactionSummarizerRequest,
  combineSplitTurnSummary,
  DEFAULT_COMPACTION_SUMMARY_MAX_TOKENS,
  estimateCompactionTextTokens,
  repairOversizedCompactionSummary,
  validateCompactionSummary,
  type CompactionSummarizerRequest,
} from './compaction-serialization.js'
import {
  runBeforeCompactHook,
  type CompactionHooks,
} from './compaction-hooks.js'
import type { MailboxAttentionState } from './mailbox-handled.js'

const DEFAULT_COMPACTION_TAIL_CHARS = 12_000
const DEFAULT_COMPACTION_FAILURE_BACKOFF_MS = 10 * 60_000
const MAX_SUMMARY_CHARS = 4_000
const SUMMARY_HEAD_PREFIX = '[历史摘要]\n'
const SUMMARY_HEADINGS = [
  '## 讨论过的话题',
  '## 群友信息',
  '## 我的承诺和状态',
  '## 工具调用结果',
  '## 情绪和氛围',
] as const

const log = createLogger('COMPACTION')

export interface ReadyCompactionPreparation {
  status: 'ready'
  reason: CompactionReason
  expectedHeadEntryId: bigint | null
  firstKeptEntryId: bigint
  entriesToSummarize: MessageAgentLedgerEntry[]
  historyEntries: MessageAgentLedgerEntry[]
  splitTurnPrefixEntries: MessageAgentLedgerEntry[]
  tailEntries: MessageAgentLedgerEntry[]
  isSplitTurn: boolean
  tokensBefore: number
  estimatedTailTokens: number
  previousCompaction: CompactionAgentLedgerEntry | null
  manualFocus?: string
}

export interface CannotCompactPreparation {
  status: 'cannot_compact'
  reason: 'no_legal_cut' | 'invalid_atomic_history' | 'stale_projection'
  expectedHeadEntryId: bigint | null
}

export type CompactionPreparation = ReadyCompactionPreparation | CannotCompactPreparation

export type CompactionCandidateResult =
  | {
      status: 'ready'
      payload: CompactionLedgerPayload
      projection: AgentLedgerProjection
      summaryTokens: number
      repairCount: 0 | 1
    }
  | { status: 'cancelled'; reason: string }
  | { status: 'invalid'; reason: string; repairCount: 0 | 1 }

export type CompactionCandidateSummarize = (
  request: CompactionSummarizerRequest,
  options: { signal: AbortSignal },
) => Promise<string>

interface AtomicMessageUnit {
  entries: MessageAgentLedgerEntry[]
  tokens: number
}

/**
 * 只做确定性切点准备，不调用 LLM、不写 ledger，也不修改 AgentContext。
 * threshold 使用严格大于；overflow/manual 由调用方显式触发。
 */
export function prepareCompaction(input: {
  entries: readonly AgentLedgerEntry[]
  latestProjection: AgentLedgerProjection
  previousCompaction: CompactionAgentLedgerEntry | null
  contextTokens: number
  contextWindowTokens: number
  reserveTokens: number
  keepRecentTokens: number
  reason: CompactionReason
  manualFocus?: string
}): CompactionPreparation | null {
  validatePreparationNumbers(input)
  const triggerTokens = Math.max(0, input.contextWindowTokens - input.reserveTokens)
  if (input.reason === 'threshold' && input.contextTokens <= triggerTokens) return null

  const expectedHeadEntryId = input.latestProjection.throughEntryId
  const canonicalHead = input.entries.at(-1)?.id ?? null
  if (canonicalHead !== expectedHeadEntryId) {
    return { status: 'cannot_compact', reason: 'stale_projection', expectedHeadEntryId }
  }

  const latestCanonicalCompaction = findLatestCompaction(input.entries)
  const previousCompaction = input.previousCompaction ?? latestCanonicalCompaction
  if (
    latestCanonicalCompaction?.id !== previousCompaction?.id
    || (input.previousCompaction != null
      && !input.entries.some((entry) => entry.id === input.previousCompaction!.id))
  ) {
    return { status: 'cannot_compact', reason: 'stale_projection', expectedHeadEntryId }
  }

  const activeEntries = selectActiveMessageEntries(input.entries, previousCompaction)
  const units = buildAtomicUnits(activeEntries)
  if (units == null) {
    return { status: 'cannot_compact', reason: 'invalid_atomic_history', expectedHeadEntryId }
  }
  if (units.length < 2) {
    return { status: 'cannot_compact', reason: 'no_legal_cut', expectedHeadEntryId }
  }

  const rawBoundary = selectRawBoundary(units, input.keepRecentTokens)
  if (rawBoundary <= 0) {
    return { status: 'cannot_compact', reason: 'no_legal_cut', expectedHeadEntryId }
  }
  const latestTurnStart = findLatestUserUnitIndex(units)
  const latestTurnTokens = units
    .slice(Math.max(0, latestTurnStart))
    .reduce((sum, unit) => sum + unit.tokens, 0)
  const latestTurnIsOversized = latestTurnTokens > input.keepRecentTokens
  const preferredUserBoundary = latestTurnIsOversized
    ? -1
    : findPreferredUserBoundary(units, rawBoundary)
  const boundaryUnitIndex = preferredUserBoundary > 0 ? preferredUserBoundary : rawBoundary
  if (boundaryUnitIndex <= 0 || boundaryUnitIndex >= units.length) {
    return { status: 'cannot_compact', reason: 'no_legal_cut', expectedHeadEntryId }
  }

  const entriesToSummarize = units
    .slice(0, boundaryUnitIndex)
    .flatMap((unit) => unit.entries)
  const tailUnits = units.slice(boundaryUnitIndex)
  const tailEntries = tailUnits.flatMap((unit) => unit.entries)
  if (entriesToSummarize.length === 0 || tailEntries.length === 0) {
    return { status: 'cannot_compact', reason: 'no_legal_cut', expectedHeadEntryId }
  }

  const firstKept = tailEntries[0]!
  const isSplitTurn = firstKept.payload.message.role !== 'user'
    && (latestTurnStart < 0 || boundaryUnitIndex > latestTurnStart || preferredUserBoundary <= 0)
  const splitTurnStart = isSplitTurn ? Math.max(0, latestTurnStart) : boundaryUnitIndex
  const historyEntries = units
    .slice(0, splitTurnStart)
    .flatMap((unit) => unit.entries)
  const splitTurnPrefixEntries = isSplitTurn
    ? units.slice(splitTurnStart, boundaryUnitIndex).flatMap((unit) => unit.entries)
    : []
  return {
    status: 'ready',
    reason: input.reason,
    expectedHeadEntryId,
    firstKeptEntryId: firstKept.id,
    entriesToSummarize,
    historyEntries,
    splitTurnPrefixEntries,
    tailEntries,
    isSplitTurn,
    tokensBefore: input.contextTokens,
    estimatedTailTokens: tailUnits.reduce((sum, unit) => sum + unit.tokens, 0),
    previousCompaction,
    ...(input.manualFocus === undefined ? {} : { manualFocus: input.manualFocus }),
  }
}

/**
 * 在事务外生成并验证 compaction candidate。这里绝不写 ledger，也不调用 afterCompact；
 * Task 10 的 coordinator 只有在 appendCompaction 成功后才能发送 afterCompact 通知。
 */
export async function createCompactionCandidate(input: {
  entries: readonly AgentLedgerEntry[]
  runtimeState: AgentRuntimeState
  preparation: ReadyCompactionPreparation
  summarize: CompactionCandidateSummarize
  hooks?: CompactionHooks
  signal?: AbortSignal
  maxSummaryTokens?: number
  mailboxAttentionState?: MailboxAttentionState
  restResumeState?: RestResumeCompactionState | null
}): Promise<CompactionCandidateResult> {
  const hooks = input.hooks ?? {}
  const signal = input.signal ?? new AbortController().signal
  const beforeResult = await runBeforeCompactHook(hooks, {
    preparation: input.preparation,
    reason: input.preparation.reason,
    ...(input.preparation.manualFocus === undefined
      ? {}
      : { manualFocus: input.preparation.manualFocus }),
    signal,
  })
  if (beforeResult.action === 'cancel') {
    return { status: 'cancelled', reason: beforeResult.reason }
  }
  if (signal.aborted) return { status: 'cancelled', reason: 'aborted' }

  const maxSummaryTokens = input.maxSummaryTokens
    ?? DEFAULT_COMPACTION_SUMMARY_MAX_TOKENS
  let rawSummary: string
  if (beforeResult.action === 'use_summary') {
    rawSummary = beforeResult.summary
  } else {
    const previousSummary = input.preparation.previousCompaction?.payload.summary ?? null
    const historyEntries = filterSummarizerMachineState(input.preparation.historyEntries)
    const mainSummary = await input.summarize(buildCompactionSummarizerRequest({
      previousSummary,
      entries: historyEntries,
      kind: 'history',
      ...(input.preparation.manualFocus === undefined
        ? {}
        : { manualFocus: input.preparation.manualFocus }),
    }), { signal })
    if (signal.aborted) return { status: 'cancelled', reason: 'aborted' }
    if (input.preparation.isSplitTurn) {
      const prefixSummary = await input.summarize(buildCompactionSummarizerRequest({
        previousSummary: null,
        entries: filterSummarizerMachineState(input.preparation.splitTurnPrefixEntries),
        kind: 'split_turn_prefix',
        ...(input.preparation.manualFocus === undefined
          ? {}
          : { manualFocus: input.preparation.manualFocus }),
      }), { signal })
      rawSummary = combineSplitTurnSummary(mainSummary, prefixSummary)
    } else {
      rawSummary = mainSummary
    }
  }
  if (signal.aborted) return { status: 'cancelled', reason: 'aborted' }

  let repairCount: 0 | 1 = 0
  let validation = validateCompactionSummary(rawSummary, {
    maxTokens: maxSummaryTokens,
    isSplitTurn: input.preparation.isSplitTurn,
  })
  if (!validation.ok && validation.reason === 'token_limit') {
    repairCount = 1
    const repaired = repairOversizedCompactionSummary(rawSummary, {
      maxTokens: maxSummaryTokens,
      isSplitTurn: input.preparation.isSplitTurn,
    })
    if (repaired) {
      validation = validateCompactionSummary(repaired, {
        maxTokens: maxSummaryTokens,
        isSplitTurn: input.preparation.isSplitTurn,
      })
    }
  }
  if (!validation.ok) {
    return { status: 'invalid', reason: validation.reason, repairCount }
  }

  const compressedMessages = input.preparation.entriesToSummarize
    .map((entry) => entry.payload.message)
  const mailboxAttentionState = input.mailboxAttentionState
    ?? captureMailboxAttentionState(compressedMessages)
  const payload: CompactionLedgerPayload = {
    schemaVersion: AGENT_LEDGER_SCHEMA_VERSION,
    summary: validation.summary,
    firstKeptEntryId: input.preparation.firstKeptEntryId.toString(),
    tokensBefore: input.preparation.tokensBefore,
    estimatedTokensAfter: safeTokenSum(
      input.preparation.estimatedTailTokens,
      estimateCompactionTextTokens(validation.summary),
    ),
    reason: input.preparation.reason,
    isSplitTurn: input.preparation.isSplitTurn,
    previousCompactionEntryId: input.preparation.previousCompaction?.id.toString() ?? null,
    mailboxAttentionState,
    restResumeState: input.restResumeState ?? null,
    ...(input.preparation.manualFocus === undefined
      ? {}
      : { manualFocus: input.preparation.manualFocus }),
  }

  const expectedHead = input.preparation.expectedHeadEntryId
  if (expectedHead == null || input.runtimeState.ledgerHeadEntryId !== expectedHead) {
    return { status: 'invalid', reason: 'candidate_projection_invalid', repairCount }
  }
  const candidateId = expectedHead + 1n
  const candidateEntry: CompactionAgentLedgerEntry = {
    id: candidateId,
    entryType: 'compaction',
    payload,
    createdAt: new Date(0),
  }
  try {
    const projection = projectAgentLedger({
      entries: [...input.entries, candidateEntry],
      runtimeState: { ...input.runtimeState, ledgerHeadEntryId: candidateId },
    })
    return {
      status: 'ready',
      payload,
      projection,
      summaryTokens: validation.tokens,
      repairCount,
    }
  } catch {
    return { status: 'invalid', reason: 'candidate_projection_invalid', repairCount }
  }
}

function filterSummarizerMachineState(
  entries: readonly MessageAgentLedgerEntry[],
): MessageAgentLedgerEntry[] {
  return entries.filter((entry) => !isMailboxAttentionStateMessage(entry.payload.message))
}

function safeTokenSum(left: number, right: number): number {
  const total = left + right
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER
}

function validatePreparationNumbers(input: {
  contextTokens: number
  contextWindowTokens: number
  reserveTokens: number
  keepRecentTokens: number
}): void {
  const values = {
    contextTokens: input.contextTokens,
    contextWindowTokens: input.contextWindowTokens,
    reserveTokens: input.reserveTokens,
    keepRecentTokens: input.keepRecentTokens,
  }
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`)
    }
  }
  if (input.contextWindowTokens === 0) {
    throw new RangeError('contextWindowTokens must be greater than zero')
  }
}

function findLatestCompaction(
  entries: readonly AgentLedgerEntry[],
): CompactionAgentLedgerEntry | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (entry.entryType === 'compaction') return entry
  }
  return null
}

function selectActiveMessageEntries(
  entries: readonly AgentLedgerEntry[],
  previousCompaction: CompactionAgentLedgerEntry | null,
): MessageAgentLedgerEntry[] {
  if (previousCompaction == null) {
    return entries.filter((entry): entry is MessageAgentLedgerEntry => entry.entryType === 'message')
  }
  const boundary = previousCompaction.payload.firstKeptEntryId == null
    ? null
    : BigInt(previousCompaction.payload.firstKeptEntryId)
  return entries.filter((entry): entry is MessageAgentLedgerEntry => (
    entry.entryType === 'message'
    && (entry.id > previousCompaction.id || (boundary != null && entry.id >= boundary))
  ))
}

function buildAtomicUnits(
  entries: readonly MessageAgentLedgerEntry[],
): AtomicMessageUnit[] | null {
  const units: AtomicMessageUnit[] = []
  let index = 0
  while (index < entries.length) {
    const entry = entries[index]!
    const message = entry.payload.message
    if (message.role === 'tool') return null
    if (message.role !== 'assistant' || message.toolCalls.length === 0) {
      units.push({ entries: [entry], tokens: estimateEntryTokens(entry).tokens })
      index += 1
      continue
    }

    const expectedIds = message.toolCalls.map((call) => call.id)
    const toolEntries = entries.slice(index + 1, index + 1 + expectedIds.length)
    if (
      toolEntries.length !== expectedIds.length
      || toolEntries.some((toolEntry, offset) => (
        toolEntry.payload.message.role !== 'tool'
        || toolEntry.payload.message.toolCallId !== expectedIds[offset]
      ))
    ) return null
    const atomicEntries = [entry, ...toolEntries]
    units.push({
      entries: atomicEntries,
      tokens: atomicEntries.reduce(
        (sum, atomicEntry) => sum + estimateEntryTokens(atomicEntry).tokens,
        0,
      ),
    })
    index += atomicEntries.length
  }
  return units
}

function selectRawBoundary(units: readonly AtomicMessageUnit[], keepRecentTokens: number): number {
  let tokens = 0
  for (let index = units.length - 1; index >= 0; index--) {
    tokens += units[index]!.tokens
    if (tokens >= keepRecentTokens) return index
  }
  return 0
}

function findPreferredUserBoundary(
  units: readonly AtomicMessageUnit[],
  rawBoundary: number,
): number {
  for (let index = rawBoundary; index >= 0; index--) {
    if (units[index]!.entries[0]!.payload.message.role === 'user') {
      if (index > 0) return index
      break
    }
  }
  for (let index = rawBoundary + 1; index < units.length; index++) {
    if (units[index]!.entries[0]!.payload.message.role === 'user') return index
  }
  return -1
}

function findLatestUserUnitIndex(units: readonly AtomicMessageUnit[]): number {
  for (let index = units.length - 1; index >= 0; index--) {
    if (units[index]!.entries[0]!.payload.message.role === 'user') return index
  }
  return -1
}
const failureBackoffByContext = new WeakMap<AgentContext, {
  nextRetryAtMs: number
  failedMessageCount: number
  reason: string
}>()

const SUMMARIZER_SYSTEM_PROMPT = `
你是一个对话摘要助手。把以下历史对话压缩成结构化摘要。

按以下分类分段输出（每段可为空但标题必须保留）：

## 讨论过的话题
已讨论的话题和结论，按时间顺序。

## 群友信息
提到的群友偏好、性格特点、关系动态。用 QQ 号标识（不是昵称）。

## 我的承诺和状态
我（assistant）说过、承诺过、正在进行的事。

## 工具调用结果
关键的工具查询结果（股票、网页、图片描述等）的摘要。

## 情绪和氛围
当前对话的整体氛围、群友的情绪状态。

规则：
- 如果给了 [上次摘要]，合并新旧信息，不要简单 append
- 忽略客套、口水、未展开的玩笑
- 每段控制在 700 字以内，总摘要不超过 4000 字
- 不要回应或继续对话，直接输出摘要
`.trim()

const SUMMARIZER_TRIGGER_INSTRUCTION = '请把以上历史对话压缩成结构化中文摘要。'

export interface SummarizeInput {
  previousSummary: string | null
  history: AgentMessage[]
}

export type SummarizeFn = (input: SummarizeInput) => Promise<string>

export interface MaybeCompactOptions {
  summarize?: SummarizeFn
  summarizeCandidate?: CompactionCandidateSummarize
  hooks?: CompactionHooks
  triggerTokens?: number
  reserveTokens?: number
  keepRecentTokens?: number
  maxSummaryTokens?: number
  tailMaxChars?: number
  failureBackoffMs?: number
  nowMs?: () => number
  /** 兼容测试/调用方；显式传入时转换为确定性的 serialized-char budget。 */
  keepRatio?: number
}

export async function summarizeCompactionCandidate(
  request: CompactionSummarizerRequest,
  options: { signal?: AbortSignal; llm?: ReturnType<typeof createLlmClient> } = {},
): Promise<string> {
  const llm = options.llm ?? createLlmClient()
  const result = await llm.chat({
    systemPrompt: request.systemPrompt,
    messages: request.messages,
    tools: [],
    signal: options.signal,
  })
  recordTokenUsage({
    operation: 'compaction',
    inputTokens: result.usage.inputTokens,
    cachedTokens: result.usage.cachedTokens,
    outputTokens: result.usage.outputTokens,
    model: result.model,
  })
  return result.content.trim()
}

export function findSafeCutIndex(messages: AgentMessage[], keepCount: number): number {
  if (messages.length <= keepCount) return 0
  let cut = messages.length - keepCount
  if (cut <= 0) return 0

  while (cut > 0) {
    const headOfTail = messages[cut]
    if (headOfTail?.role === 'tool') {
      cut--
      continue
    }
    const before = messages[cut - 1]
    if (before?.role === 'assistant' && before.toolCalls.length > 0) {
      cut--
      continue
    }
    break
  }
  return cut
}

function splitExistingSummary(messages: AgentMessage[]): {
  previousSummary: string | null
  rest: AgentMessage[]
} {
  const head = messages[0]
  if (head?.role !== 'user' || !head.content.startsWith(SUMMARY_HEAD_PREFIX)) {
    return { previousSummary: null, rest: messages }
  }
  const summaryWithoutRuntimeState = stripRestResumeReminderCompactionSuffix(head.content)
  return {
    previousSummary: summaryWithoutRuntimeState.slice(SUMMARY_HEAD_PREFIX.length).trim(),
    rest: messages.slice(1),
  }
}

function stripImagesForSummary(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.nativeBlocks !== undefined) {
      return {
        role: 'assistant',
        content: m.content,
        toolCalls: m.toolCalls,
      }
    }
    if (m.role !== 'tool' || typeof m.content === 'string') return m
    return {
      ...m,
      content: m.content.map((block) =>
        block.type === 'text' ? block : { type: 'text' as const, text: '[图片]' },
      ),
    }
  })
}

function stripInactiveNativeBlocks(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message, index) => {
    if (
      message.role !== 'assistant' ||
      message.nativeBlocks === undefined ||
      isActiveToolCycleAtTail(messages, index)
    ) {
      return message
    }
    return {
      role: 'assistant',
      content: message.content,
      toolCalls: message.toolCalls,
    }
  })
}

function isActiveToolCycleAtTail(messages: AgentMessage[], index: number): boolean {
  const message = messages[index]
  if (!message || message.role !== 'assistant' || message.toolCalls.length === 0) {
    return false
  }

  const pendingToolCallIds = new Set(message.toolCalls.map((call) => call.id))
  let cursor = index + 1
  while (cursor < messages.length) {
    const next = messages[cursor]
    if (!next || next.role !== 'tool' || !pendingToolCallIds.has(next.toolCallId)) break
    pendingToolCallIds.delete(next.toolCallId)
    cursor += 1
  }

  return pendingToolCallIds.size === 0 && cursor === messages.length
}

function serializedMessageChars(message: AgentMessage): number {
  return JSON.stringify(message).length
}

function selectTailCutIndex(messages: AgentMessage[], options: MaybeCompactOptions): number {
  const totalChars = messages.reduce((sum, message) => sum + serializedMessageChars(message), 0)
  const explicitRatio = options.keepRatio
  const budget = Math.max(1, Math.floor(
    options.tailMaxChars
      ?? (explicitRatio == null
        ? DEFAULT_COMPACTION_TAIL_CHARS
        : totalChars * Math.min(1, Math.max(0, explicitRatio))),
  ))
  let keepChars = 0
  let cutIndex = messages.length
  while (cutIndex > 0) {
    const nextChars = serializedMessageChars(messages[cutIndex - 1]!)
    if (keepChars > 0 && keepChars + nextChars > budget) break
    keepChars += nextChars
    cutIndex--
    if (keepChars >= budget) break
  }

  const keepCount = messages.length - cutIndex
  cutIndex = findSafeCutIndex(messages, keepCount)
  const lastCompleteToolCycle = findLastCompleteToolCycleStart(messages)
  if (lastCompleteToolCycle != null && cutIndex > lastCompleteToolCycle) {
    cutIndex = lastCompleteToolCycle
  }
  return cutIndex
}

function findLastCompleteToolCycleStart(messages: AgentMessage[]): number | null {
  let latest: number | null = null
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message || message.role !== 'assistant' || message.toolCalls.length === 0) continue
    const complete = message.toolCalls.every((call, offset) => {
      const result = messages[index + offset + 1]
      return result?.role === 'tool' && result.toolCallId === call.id
    })
    if (complete) latest = index
  }
  return latest
}

function validateSummary(summary: string): { ok: true; summary: string } | { ok: false; reason: string } {
  const trimmed = summary.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  if (trimmed.length > MAX_SUMMARY_CHARS) return { ok: false, reason: 'too_long' }

  const lines = trimmed.split('\n').map((line) => line.trimEnd())
  let previousIndex = -1
  for (const heading of SUMMARY_HEADINGS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex > previousIndex && line === heading)
    if (index < 0) return { ok: false, reason: `missing_heading:${heading}` }
    previousIndex = index
  }
  const content = lines.filter((line) => !SUMMARY_HEADINGS.includes(line as typeof SUMMARY_HEADINGS[number]))
    .join('\n')
    .trim()
  if (!content) return { ok: false, reason: 'empty_sections' }
  return { ok: true, summary: trimmed }
}

function repairOversizedSummary(summary: string): string | null {
  const lines = summary.trim().split('\n').map((line) => line.trimEnd())
  const headingIndexes: number[] = []
  let previousIndex = -1
  for (const heading of SUMMARY_HEADINGS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex > previousIndex && line === heading)
    if (index < 0) return null
    headingIndexes.push(index)
    previousIndex = index
  }

  const sections = SUMMARY_HEADINGS.map((heading, index) => {
    const start = headingIndexes[index]! + 1
    const end = headingIndexes[index + 1] ?? lines.length
    return { heading, body: lines.slice(start, end).join('\n').trim() }
  })
  if (!sections.some((section) => section.body.length > 0)) return null

  const fixedChars = SUMMARY_HEADINGS.join('\n\n').length + (SUMMARY_HEADINGS.length - 1) * 2
  const perSectionChars = Math.max(1, Math.floor((MAX_SUMMARY_CHARS - fixedChars) / sections.length))
  return sections.map(({ heading, body }) => {
    if (!body) return heading
    const repairedBody = body.length <= perSectionChars
      ? body
      : `${body.slice(0, Math.max(0, perSectionChars - 1)).trimEnd()}…`
    return `${heading}\n${repairedBody}`
  }).join('\n\n')
}

async function defaultSummarize(input: SummarizeInput): Promise<string> {
  const llm = createLlmClient()

  const result = await llm.chat({
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    messages: buildCompactionSummarizerMessages(input),
    tools: [],
  })

  recordTokenUsage({
    operation: 'compaction',
    inputTokens: result.usage.inputTokens,
    cachedTokens: result.usage.cachedTokens,
    outputTokens: result.usage.outputTokens,
    model: result.model,
  })

  if (result.content.length === 0) {
    log.warn({}, 'summarizer_empty_response')
    return ''
  }
  return result.content.trim()
}

export function buildCompactionSummarizerMessages(input: SummarizeInput): AgentMessage[] {
  const dataMessages: AgentMessage[] = []
  const previous = input.previousSummary?.trim()
  if (previous) dataMessages.push({ role: 'user', content: `[上次摘要]\n${previous}` })
  dataMessages.push(...stripImagesForSummary(input.history))
  const serializedChars = dataMessages.reduce((sum, message) => sum + JSON.stringify(message).length, 0)
  return [
    {
      role: 'user',
      content: renderUntrustedTranscript({
        purpose: 'compaction',
        messages: dataMessages,
        maxChars: serializedChars + 2_000,
      }),
    },
    { role: 'user', content: SUMMARIZER_TRIGGER_INSTRUCTION },
  ]
}

export async function maybeCompactConversation(
  context: AgentContext,
  lastInputTokens: number | null,
  options: MaybeCompactOptions = {},
): Promise<boolean> {
  return await compactConversation(context, lastInputTokens, options, false)
}

/** Provider 已拒绝当前 prompt 时强制压缩；调用方负责限制每轮恢复次数。 */
export async function compactConversationForRecovery(
  context: AgentContext,
  options: MaybeCompactOptions = {},
): Promise<boolean> {
  return await compactConversation(context, null, options, true)
}

async function compactConversation(
  context: AgentContext,
  lastInputTokens: number | null,
  options: MaybeCompactOptions,
  force: boolean,
): Promise<boolean> {
  if (lastInputTokens == null && !force) return false

  const summarize = options.summarize ?? defaultSummarize
  const configuredContextWindow = config.llm.contextWindowTokensByModel[config.llm.defaultModel]
  const triggerTokens = options.triggerTokens
    ?? configuredContextWindow - config.compaction.reserveTokens
  const selectionOptions = options.keepRatio == null && options.tailMaxChars == null
    ? { ...options, tailMaxChars: DEFAULT_COMPACTION_TAIL_CHARS }
    : options

  if (!force && lastInputTokens! <= triggerTokens) return false

  const snapshot = context.getSnapshot()
  const nowMs = options.nowMs ?? Date.now
  const failureBackoffMs = Math.max(
    1,
    options.failureBackoffMs ?? DEFAULT_COMPACTION_FAILURE_BACKOFF_MS,
  )
  const existingBackoff = failureBackoffByContext.get(context)
  if (!force && existingBackoff) {
    if (snapshot.messages.length < existingBackoff.failedMessageCount) {
      failureBackoffByContext.delete(context)
    } else {
      const retryAfterMs = existingBackoff.nextRetryAtMs - nowMs()
      if (retryAfterMs > 0) {
        log.debug({
          inputTokens: lastInputTokens,
          messageCount: snapshot.messages.length,
          retryAfterMs,
          reason: existingBackoff.reason,
        }, 'compaction_failure_backoff_skipped')
        return false
      }
    }
  }

  const recordFailure = (reason: string) => {
    if (force) return
    failureBackoffByContext.set(context, {
      nextRetryAtMs: nowMs() + failureBackoffMs,
      failedMessageCount: snapshot.messages.length,
      reason,
    })
  }

  log.info(
    { inputTokens: lastInputTokens, messageCount: snapshot.messages.length, triggerTokens, force },
    force ? 'compaction_recovery_triggered' : 'compaction_triggered',
  )

  const cutIndex = selectTailCutIndex(snapshot.messages, selectionOptions)
  if (cutIndex <= 0) {
    log.warn(
      { inputTokens: lastInputTokens, messageCount: snapshot.messages.length },
      'compaction_no_safe_cut',
    )
    recordFailure('no_safe_cut')
    return false
  }

  const toCompress = snapshot.messages.slice(0, cutIndex)
  const tail = stripInactiveNativeBlocks(snapshot.messages.slice(cutIndex))
  const mailboxAttentionState = captureMailboxAttentionState(toCompress)
  const { previousSummary, rest: historyAfterSummary } = splitExistingSummary(toCompress)
  const historyToSummarize = historyAfterSummary.filter(
    (message) => !isMailboxAttentionStateMessage(message),
  )

  if (historyToSummarize.length === 0 && !previousSummary) {
    return false
  }

  let rawSummary: string
  try {
    rawSummary = await summarize({
      previousSummary,
      history: stripImagesForSummary(historyToSummarize),
    })
  } catch (err) {
    log.error({ err, inputTokens: lastInputTokens, cutIndex, force }, 'summarizer_failed_context_preserved')
    recordFailure('summarizer_failed')
    return false
  }
  let validatedSummary = validateSummary(rawSummary)
  if (!validatedSummary.ok && validatedSummary.reason === 'too_long') {
    const repairedSummary = repairOversizedSummary(rawSummary)
    if (repairedSummary) {
      validatedSummary = validateSummary(repairedSummary)
      if (validatedSummary.ok) {
        log.info({ inputTokens: lastInputTokens, cutIndex }, 'compaction_summary_repaired_once')
      }
    }
  }
  if (!validatedSummary.ok) {
    log.warn({
      inputTokens: lastInputTokens,
      cutIndex,
      tailLen: tail.length,
      reason: validatedSummary.reason,
    }, 'compaction_candidate_summary_rejected')
    recordFailure(validatedSummary.reason)
    return false
  }

  const summaryWithoutRuntimeState = stripRestResumeReminderCompactionSuffix(
    `${SUMMARY_HEAD_PREFIX}${validatedSummary.summary}`,
  )
  const summaryMessage: AgentMessage = {
    role: 'user',
    content: `${summaryWithoutRuntimeState}${renderRestResumeReminderCompactionSuffix(toCompress)}`,
  }
  const mailboxAttentionStateMessage: AgentMessage[] = Object.keys(mailboxAttentionState).length > 0
    ? [{ role: 'user', content: renderMailboxAttentionStateEvent(mailboxAttentionState) }]
    : []
  const candidateMessages = [summaryMessage, ...mailboxAttentionStateMessage, ...tail]
  const integrity = validateBotSnapshotIntegrity({
    snapshot: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      messages: candidateMessages,
      activeToolCapabilities: snapshot.activeToolCapabilities,
    },
    mailboxCursors: {},
    goalRevision: 0,
  })
  if (!integrity.ok) {
    log.error({
      inputTokens: lastInputTokens,
      cutIndex,
      errors: integrity.errors,
    }, 'compaction_candidate_integrity_rejected')
    recordFailure('integrity_rejected')
    return false
  }

  context.replaceMessages(candidateMessages)
  failureBackoffByContext.delete(context)

  log.info(
    {
      previousMessages: snapshot.messages.length,
      newMessages: candidateMessages.length,
      compressedCount: toCompress.length,
      keptCount: tail.length,
      inputTokensBefore: lastInputTokens,
    },
    'compaction_replaced',
  )
  return true
}
