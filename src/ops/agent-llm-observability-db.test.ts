import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LlmCallObservation } from '../agent/llm-observability.js'

test('LLM observation recorder writes sanitized non-replay data', async () => {
  const writes: unknown[] = []
  const { persistAgentLlmCallObservation } = await import('./agent-llm-observability-db.js')
  const observation: LlmCallObservation = {
    callId: 'call-1',
    ts: '2026-07-23T10:00:00.000Z',
    operation: 'agent.chat',
    roundIndex: 2,
    provider: 'openai-agent',
    model: 'gpt-test',
    status: 'completed',
    durationMs: 12,
    canonicalRequest: { apiKey: 'secret', messages: [] },
    wireRequest: { authorization: 'Bearer secret' },
    canonicalResponse: { content: 'ok' },
    wireResponse: { id: 'response-1' },
    requestId: 'request-1',
    httpStatus: 200,
    inputTokens: 5,
    cachedTokens: 3,
    outputTokens: 1,
    stopReason: 'end_turn',
    error: null,
  }

  await persistAgentLlmCallObservation(observation, {
    agentLlmCall: {
      async create(input) {
        writes.push(input)
        return {}
      },
    },
  })

  assert.deepEqual(writes, [{
    data: {
      callId: 'call-1',
      ts: new Date('2026-07-23T10:00:00.000Z'),
      operation: 'agent.chat',
      roundIndex: 2,
      provider: 'openai-agent',
      model: 'gpt-test',
      status: 'completed',
      durationMs: 12,
      canonicalRequest: { apiKey: '[redacted]', messages: [] },
      wireRequest: { authorization: '[redacted]' },
      canonicalResponse: { content: 'ok' },
      wireResponse: { id: 'response-1' },
      requestId: 'request-1',
      httpStatus: 200,
      inputTokens: 5,
      cachedTokens: 3,
      outputTokens: 1,
      stopReason: 'end_turn',
      error: null,
    },
  }])
})
