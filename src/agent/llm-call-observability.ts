import { randomUUID } from 'node:crypto'
import { createLogger } from '../logger.js'
import {
  createLlmEvidenceDigest,
  createLlmEvidenceDigestFromParts,
  readLlmProviderEvidence,
  type LlmCallTraceEvidence,
} from './llm-call-evidence.js'
import type { LlmCallInput, LlmCallOutput, LlmClient } from './llm-client.js'
import {
  recordTokenUsage,
  type AgentTokenOperation,
  type TokenUsageEntry,
} from './token-stats.js'

const log = createLogger('LLM_CALL_OBSERVABILITY')

export interface LlmCallObservationContext {
  operation: AgentTokenOperation
  actor: string
  roundIndex?: number
  taskId?: string
  attempt?: number
}

export interface ObserveLlmCallDependencies {
  id?: () => string
  nowMs?: () => number
  record?: (entry: TokenUsageEntry) => void
}

export async function observeLlmCall(input: {
  llm: LlmClient
  request: LlmCallInput
  context: LlmCallObservationContext
  dependencies?: ObserveLlmCallDependencies
}): Promise<LlmCallOutput> {
  const id = input.dependencies?.id ?? randomUUID
  const nowMs = input.dependencies?.nowMs ?? Date.now
  const record = input.dependencies?.record ?? recordTokenUsage
  const callId = id()
  const startedAt = nowMs()
  const canonicalRequest = summarizeCanonicalRequest(input.request)

  try {
    const output = await input.llm.chat(input.request)
    const providerEvidence = output.providerEvidence
    safeRecord(record, {
      callId,
      operation: input.context.operation,
      actor: input.context.actor,
      ...(input.context.roundIndex != null ? { roundIndex: input.context.roundIndex } : {}),
      ...(input.context.taskId ? { taskId: input.context.taskId } : {}),
      ...(input.context.attempt != null ? { attempt: input.context.attempt } : {}),
      provider: providerEvidence?.provider ?? input.llm.provider,
      status: 'succeeded',
      durationMs: elapsed(startedAt, nowMs()),
      ...(output.stopReason ? { stopReason: output.stopReason } : {}),
      inputTokens: output.usage.inputTokens,
      cachedTokens: output.usage.cachedTokens,
      outputTokens: output.usage.outputTokens,
      model: output.model,
      evidence: {
        canonicalRequest,
        ...(providerEvidence?.request ? { providerRequest: providerEvidence.request } : {}),
        ...(providerEvidence?.response ? { providerResponse: providerEvidence.response } : {}),
        canonicalResponse: summarizeCanonicalResponse(output),
      },
    })
    return output
  } catch (error) {
    const providerEvidence = readLlmProviderEvidence(error)
    const aborted = input.request.signal?.aborted === true
      || (error instanceof Error && error.name === 'AbortError')
    safeRecord(record, {
      callId,
      operation: input.context.operation,
      actor: input.context.actor,
      ...(input.context.roundIndex != null ? { roundIndex: input.context.roundIndex } : {}),
      ...(input.context.taskId ? { taskId: input.context.taskId } : {}),
      ...(input.context.attempt != null ? { attempt: input.context.attempt } : {}),
      provider: providerEvidence?.provider ?? input.llm.provider,
      status: aborted ? 'aborted' : 'failed',
      durationMs: elapsed(startedAt, nowMs()),
      errorKind: aborted ? 'aborted' : classifyError(error),
      inputTokens: null,
      cachedTokens: null,
      outputTokens: null,
      model: providerEvidence?.request.summary.model ?? 'unknown',
      evidence: {
        canonicalRequest,
        ...(providerEvidence?.request ? { providerRequest: providerEvidence.request } : {}),
        ...(providerEvidence?.response ? { providerResponse: providerEvidence.response } : {}),
      },
    })
    throw error
  }
}

function summarizeCanonicalRequest(input: LlmCallInput) {
  const fingerprintMetadata = {
    cacheBreakpointMessageIndexes: input.cacheBreakpointMessageIndexes,
    claudeToolChoice: input.claudeToolChoice,
    maxOutputTokens: input.maxOutputTokens,
  }
  return createLlmEvidenceDigestFromParts([
    input.systemPrompt,
    ...input.messages,
    ...input.tools.map(tool => ({ name: tool.name, description: tool.description })),
    fingerprintMetadata,
  ], {
    systemChars: input.systemPrompt.length,
    messageCount: input.messages.length,
    messageRoles: input.messages.map(message => message.role),
    toolNames: input.tools.map(tool => tool.name),
    cacheBreakpointCount: input.cacheBreakpointMessageIndexes?.length ?? 0,
    ...(input.claudeToolChoice ? { toolChoice: input.claudeToolChoice } : {}),
    ...(input.maxOutputTokens != null ? { maxOutputTokens: input.maxOutputTokens } : {}),
  })
}

function summarizeCanonicalResponse(output: LlmCallOutput) {
  return createLlmEvidenceDigest({
    content: output.content,
    toolCalls: output.toolCalls,
    nativeBlocks: output.nativeBlocks,
    model: output.model,
    stopReason: output.stopReason,
  }, {
    model: output.model,
    contentChars: output.content.length,
    contentBlockTypes: output.nativeBlocks?.map(block => block.type) ?? [],
    toolNames: output.toolCalls.map(call => call.name),
    ...(output.stopReason ? { stopReason: output.stopReason } : {}),
  })
}

function safeRecord(record: (entry: TokenUsageEntry) => void, entry: TokenUsageEntry): void {
  try {
    record(entry)
  } catch (error) {
    log.warn({ err: error, callId: entry.callId }, 'llm_call_observation_record_failed')
  }
}

function classifyError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown'
  const value = error as Record<string, unknown>
  for (const candidate of [value.kind, value.code, value.name]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.slice(0, 191)
  }
  return typeof value.status === 'number' ? `http_${value.status}` : 'unknown'
}

function elapsed(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt))
}
