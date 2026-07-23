import type { LlmCallObservation } from '../agent/llm-observability.js'
import { sanitizeLlmCallObservation } from '../agent/llm-observability.js'
import { prisma } from '../database/client.js'
import { createLogger } from '../logger.js'

const log = createLogger('AGENT_LLM_OBSERVABILITY_DB')

interface AgentLlmCallCreateInput {
  data: {
    callId: string
    ts: Date
    operation: string
    roundIndex: number | null
    provider: string
    model: string
    status: string
    durationMs: number
    canonicalRequest: unknown
    wireRequest: unknown
    canonicalResponse: unknown
    wireResponse: unknown
    requestId: string | null
    httpStatus: number | null
    inputTokens: number | null
    cachedTokens: number | null
    outputTokens: number | null
    stopReason: string | null
    error: string | null
  }
}

export interface AgentLlmObservationDbClient {
  agentLlmCall: {
    create(input: AgentLlmCallCreateInput): Promise<unknown>
  }
}

export async function persistAgentLlmCallObservation(
  observation: LlmCallObservation,
  db: AgentLlmObservationDbClient = prisma as unknown as AgentLlmObservationDbClient,
): Promise<void> {
  const sanitized = sanitizeLlmCallObservation(observation)
  await db.agentLlmCall.create({
    data: {
      callId: sanitized.callId,
      ts: new Date(sanitized.ts),
      operation: sanitized.operation,
      roundIndex: sanitized.roundIndex,
      provider: sanitized.provider,
      model: sanitized.model,
      status: sanitized.status,
      durationMs: sanitized.durationMs,
      canonicalRequest: sanitized.canonicalRequest,
      wireRequest: sanitized.wireRequest,
      canonicalResponse: sanitized.canonicalResponse,
      wireResponse: sanitized.wireResponse,
      requestId: sanitized.requestId,
      httpStatus: sanitized.httpStatus,
      inputTokens: sanitized.inputTokens,
      cachedTokens: sanitized.cachedTokens,
      outputTokens: sanitized.outputTokens,
      stopReason: sanitized.stopReason,
      error: sanitized.error,
    },
  })
}

export function recordAgentLlmCallObservation(observation: LlmCallObservation): void {
  persistAgentLlmCallObservation(observation).catch((error) => {
    log.warn(
      { error, callId: observation.callId, provider: observation.provider },
      'agent_llm_call_db_write_failed',
    )
  })
}
