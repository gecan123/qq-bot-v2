import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AgentMessage, AgentToolDeclaration } from './types.js'

export const CONTEXT_FRAME_SCHEMA_VERSION = 1
export const CONTEXT_FRAME_HASH_INPUT_VERSION = 1

export type ContextFrameTokenUsageState = 'captured' | 'unavailable' | 'unknown'

export interface ContextFrameTokenUsage {
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
  tokenUsageState: ContextFrameTokenUsageState
  rawUsage?: unknown
}

export interface ContextFrameSourceRefs {
  sourceKind: string
  deliveryMode?: string
  triggerMessageRowId?: number
  incorporatedMessageRowId?: number
  triggerMessageId?: number
  incorporatedMessageId?: number
  messageCursorStart?: number
  messageCursorEnd?: number
  includedActionRecordIds: string[]
  maxActionAnchor?: number
  compactionSegmentIds: string[]
}

export interface ContextFrame {
  frameSchemaVersion: number
  hashInputVersion: number
  frameId: string
  sceneId: string
  opportunityId: string
  systemPromptVersion: string
  prefixHash: string
  tailHash: string
  messageCursorStart?: number
  messageCursorEnd?: number
  includedActionRecordIds: string[]
  maxActionAnchor?: number
  compactionSegmentIds: string[]
  provider: string
  model: string
  sourceKind: string
  deliveryMode?: string
  triggerMessageRowId?: number
  triggerMessageId?: number
  incorporatedMessageRowId?: number
  incorporatedMessageId?: number
}

export interface BuildContextFrameInput {
  sceneId: string
  opportunityId: string
  systemPromptVersion: string
  systemPrompt: string
  initialHistory: AgentMessage[]
  sourceRefs: ContextFrameSourceRefs
  provider: string
  model: string
}

export function canonicalizeJson(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item))

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeJson(item)]),
  )
}

export function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(value)))
    .digest('hex')
}

export function buildInputHash(params: {
  systemPrompt: string
  history: AgentMessage[]
  tools: AgentToolDeclaration[]
}): string {
  return stableHash({
    hashInputVersion: CONTEXT_FRAME_HASH_INPUT_VERSION,
    systemPrompt: params.systemPrompt,
    history: params.history,
    tools: params.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema),
    })),
  })
}

/**
 * Phase 1.5: prefix 只含真正稳定的部分 (system + 0 或 1 条 [历史摘要] user message)。
 * window 和 trigger 进 tail。这样 cache prefix 跟 OpenAI/Anthropic 实际 cache 命中点对齐:
 * 同一会话内只要 systemPrompt 和 summary 不变, prefixHash 不变, cache 就能命中。
 */
function isSummaryHead(message: AgentMessage): boolean {
  if (message.role !== 'user') return false
  if (typeof message.content !== 'string') return false
  return message.content.startsWith('[历史摘要]')
}

function splitHistoryAtSummary(history: AgentMessage[]): {
  summaryHead: AgentMessage[]
  tail: AgentMessage[]
} {
  const summaryHead: AgentMessage[] = []
  const tail: AgentMessage[] = []
  for (const message of history) {
    if (summaryHead.length === 0 && tail.length === 0 && isSummaryHead(message)) {
      summaryHead.push(message)
      continue
    }
    tail.push(message)
  }
  return { summaryHead, tail }
}

export function buildContextFrame(input: BuildContextFrameInput): ContextFrame {
  const { summaryHead, tail } = splitHistoryAtSummary(input.initialHistory)
  const prefixMaterial = {
    hashInputVersion: CONTEXT_FRAME_HASH_INPUT_VERSION,
    systemPrompt: input.systemPrompt,
    summaryHead,
  }
  const tailMaterial = {
    hashInputVersion: CONTEXT_FRAME_HASH_INPUT_VERSION,
    history: tail,
    opportunity: {
      sceneId: input.sceneId,
      opportunityId: input.opportunityId,
      sourceKind: input.sourceRefs.sourceKind,
      deliveryMode: input.sourceRefs.deliveryMode,
      triggerMessageRowId: input.sourceRefs.triggerMessageRowId,
      incorporatedMessageRowId: input.sourceRefs.incorporatedMessageRowId,
    },
  }
  const prefixHash = stableHash(prefixMaterial)
  const tailHash = stableHash(tailMaterial)
  const frameId = stableHash({
    frameSchemaVersion: CONTEXT_FRAME_SCHEMA_VERSION,
    hashInputVersion: CONTEXT_FRAME_HASH_INPUT_VERSION,
    sceneId: input.sceneId,
    opportunityId: input.opportunityId,
    triggerMessageRowId: input.sourceRefs.triggerMessageRowId,
    prefixHash,
    tailHash,
  })

  return {
    frameSchemaVersion: CONTEXT_FRAME_SCHEMA_VERSION,
    hashInputVersion: CONTEXT_FRAME_HASH_INPUT_VERSION,
    frameId,
    sceneId: input.sceneId,
    opportunityId: input.opportunityId,
    systemPromptVersion: input.systemPromptVersion,
    prefixHash,
    tailHash,
    messageCursorStart: input.sourceRefs.messageCursorStart,
    messageCursorEnd: input.sourceRefs.messageCursorEnd,
    includedActionRecordIds: input.sourceRefs.includedActionRecordIds,
    maxActionAnchor: input.sourceRefs.maxActionAnchor,
    compactionSegmentIds: input.sourceRefs.compactionSegmentIds,
    provider: input.provider,
    model: input.model,
    sourceKind: input.sourceRefs.sourceKind,
    deliveryMode: input.sourceRefs.deliveryMode,
    triggerMessageRowId: input.sourceRefs.triggerMessageRowId,
    triggerMessageId: input.sourceRefs.triggerMessageId,
    incorporatedMessageRowId: input.sourceRefs.incorporatedMessageRowId,
    incorporatedMessageId: input.sourceRefs.incorporatedMessageId,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function findCachedTokens(usage: Record<string, unknown>): { found: boolean; value: number | null } {
  const direct = numberValue(usage.cached_tokens)
  if (direct !== null) return { found: true, value: direct }

  const promptDetails = asRecord(usage.prompt_tokens_details)
  const promptCached = numberValue(promptDetails?.cached_tokens)
  if (promptCached !== null) return { found: true, value: promptCached }

  const inputDetails = asRecord(usage.input_token_details)
  const cacheRead = numberValue(inputDetails?.cache_read)
  if (cacheRead !== null) return { found: true, value: cacheRead }

  return { found: false, value: null }
}

export function normalizeContextFrameTokenUsage(rawUsage: unknown): ContextFrameTokenUsage {
  const usage = asRecord(rawUsage)
  if (!usage) {
    return { inputTokens: null, cachedTokens: null, outputTokens: null, tokenUsageState: 'unknown' }
  }

  const inputTokens = numberValue(usage.prompt_tokens) ?? numberValue(usage.input_tokens)
  const outputTokens = numberValue(usage.completion_tokens) ?? numberValue(usage.output_tokens)
  const totalTokens = numberValue(usage.total_tokens)
  const hasUsableTotals = inputTokens !== null || outputTokens !== null || totalTokens !== null
  if (!hasUsableTotals) {
    return { inputTokens: null, cachedTokens: null, outputTokens: null, tokenUsageState: 'unknown', rawUsage }
  }

  const cachedTokens = findCachedTokens(usage)
  return {
    inputTokens,
    cachedTokens: cachedTokens.value,
    outputTokens,
    tokenUsageState: cachedTokens.found ? 'captured' : 'unavailable',
    rawUsage,
  }
}
