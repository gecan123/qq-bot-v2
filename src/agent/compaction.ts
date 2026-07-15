import type { AgentMessage } from './agent-context.types.js'
import { createLlmClient } from './llm-client.js'
import { recordTokenUsage } from './token-stats.js'
import {
  captureMailboxAttentionState,
  isMailboxAttentionStateMessage,
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
export interface MaybeCompactOptions {
  summarizeCandidate?: CompactionCandidateSummarize
  hooks?: CompactionHooks
  triggerTokens?: number
  reserveTokens?: number
  keepRecentTokens?: number
  maxSummaryTokens?: number
  failureBackoffMs?: number
  nowMs?: () => number
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
