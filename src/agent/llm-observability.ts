import { randomUUID } from 'node:crypto'
import type { LlmCallInput, LlmCallOutput, LlmClient, LlmStopReason } from './llm-client.js'

export interface LlmCallObservation {
  callId: string
  ts: string
  operation: string
  roundIndex: number | null
  provider: NonNullable<LlmClient['provider']> | 'unknown'
  model: string
  status: 'completed' | 'failed'
  durationMs: number
  canonicalRequest: unknown
  wireRequest: unknown | null
  canonicalResponse: unknown | null
  wireResponse: unknown | null
  requestId: string | null
  httpStatus: number | null
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
  stopReason: LlmStopReason | null
  error: string | null
}

export interface CreateObservedLlmClientInput {
  client: LlmClient
  record(observation: LlmCallObservation): void
  now?: () => Date
  id?: () => string
}

export function createObservedLlmClient(input: CreateObservedLlmClientInput): LlmClient {
  const now = input.now ?? (() => new Date())
  const id = input.id ?? randomUUID
  return {
    ...(input.client.provider ? { provider: input.client.provider } : {}),
    async chat(request) {
      const callId = id()
      const startedAt = now()
      try {
        const result = await input.client.chat(request)
        const finishedAt = now()
        safeRecord(input.record, completedObservation({
          callId,
          startedAt,
          finishedAt,
          provider: input.client.provider ?? 'unknown',
          request,
          result,
        }))
        return result
      } catch (error) {
        const finishedAt = now()
        safeRecord(input.record, failedObservation({
          callId,
          startedAt,
          finishedAt,
          provider: input.client.provider ?? 'unknown',
          request,
          error,
        }))
        throw error
      }
    },
  }
}

const MAX_STORED_PAYLOAD_CHARS = 1_000_000
const SENSITIVE_KEYS = /^(?:api[-_]?key|authorization|access[-_]?token|secret|password)$/i

export function sanitizeLlmCallObservation(
  observation: LlmCallObservation,
): LlmCallObservation {
  return {
    ...observation,
    canonicalRequest: sanitizePayload(observation.canonicalRequest),
    wireRequest: sanitizePayload(observation.wireRequest),
    canonicalResponse: sanitizePayload(observation.canonicalResponse),
    wireResponse: sanitizePayload(observation.wireResponse),
  }
}

export function recordLlmCallObservation(observation: LlmCallObservation): void {
  void import('../ops/agent-llm-observability-db.js')
    .then(({ recordAgentLlmCallObservation }) => recordAgentLlmCallObservation(observation))
    .catch(() => {
      // Optional observability must not affect provider execution or replay.
    })
}

function sanitizePayload(value: unknown): unknown {
  if (value == null) return null
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value, function replacer(key, current) {
      if (SENSITIVE_KEYS.test(key)) return '[redacted]'
      if (
        key === 'data'
        && typeof current === 'string'
        && this != null
        && typeof this === 'object'
        && 'type' in this
        && this.type === 'base64'
      ) {
        return `[omitted ${current.length} chars]`
      }
      if (typeof current === 'bigint') return current.toString()
      return current
    })
  } catch {
    return { unavailable: true, reason: 'serialization_failed' }
  }
  if (serialized == null) return null
  if (serialized.length > MAX_STORED_PAYLOAD_CHARS) {
    return {
      truncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, MAX_STORED_PAYLOAD_CHARS),
    }
  }
  return JSON.parse(serialized) as unknown
}

function completedObservation(input: {
  callId: string
  startedAt: Date
  finishedAt: Date
  provider: LlmCallObservation['provider']
  request: LlmCallInput
  result: LlmCallOutput
}): LlmCallObservation {
  const { observation: metadata, signal: _, ...canonicalRequest } = input.request
  const { transportTrace, ...canonicalResponse } = input.result
  return {
    callId: input.callId,
    ts: input.startedAt.toISOString(),
    operation: metadata?.operation ?? 'unknown',
    roundIndex: metadata?.roundIndex ?? null,
    provider: input.provider,
    model: input.result.model,
    status: 'completed',
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    canonicalRequest,
    wireRequest: transportTrace?.request ?? null,
    canonicalResponse,
    wireResponse: transportTrace?.response ?? null,
    requestId: transportTrace?.requestId ?? null,
    httpStatus: transportTrace?.status ?? null,
    inputTokens: input.result.usage.inputTokens,
    cachedTokens: input.result.usage.cachedTokens,
    outputTokens: input.result.usage.outputTokens,
    stopReason: input.result.stopReason ?? null,
    error: null,
  }
}

function failedObservation(input: {
  callId: string
  startedAt: Date
  finishedAt: Date
  provider: LlmCallObservation['provider']
  request: LlmCallInput
  error: unknown
}): LlmCallObservation {
  const { observation: metadata, signal: _, ...canonicalRequest } = input.request
  const error = asErrorRecord(input.error)
  return {
    callId: input.callId,
    ts: input.startedAt.toISOString(),
    operation: metadata?.operation ?? 'unknown',
    roundIndex: metadata?.roundIndex ?? null,
    provider: input.provider,
    model: typeof error.model === 'string' ? error.model : 'unknown',
    status: 'failed',
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    canonicalRequest,
    wireRequest: error.requestBody ?? null,
    canonicalResponse: null,
    wireResponse: error.responseBody ?? error.responseText ?? null,
    requestId: typeof error.requestId === 'string' ? error.requestId : null,
    httpStatus: typeof error.status === 'number' ? error.status : null,
    inputTokens: null,
    cachedTokens: null,
    outputTokens: null,
    stopReason: null,
    error: input.error instanceof Error ? input.error.message : String(input.error),
  }
}

function asErrorRecord(error: unknown): Record<string, unknown> {
  return error != null && typeof error === 'object'
    ? error as Record<string, unknown>
    : {}
}

function safeRecord(
  record: (observation: LlmCallObservation) => void,
  observation: LlmCallObservation,
): void {
  try {
    record(observation)
  } catch {
    // Observability is best-effort and must never change LLM behavior.
  }
}
