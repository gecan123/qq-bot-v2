import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LlmCallObservation } from './llm-observability.js'
import type { LlmClient } from './llm-client.js'

test('observed LLM client records one completed call without changing the result', async () => {
  const observations: LlmCallObservation[] = []
  const output = {
    content: 'done',
    toolCalls: [],
    usage: { inputTokens: 12, cachedTokens: 7, outputTokens: 3 },
    model: 'test-model',
    contextWindowTokens: 1000,
    stopReason: 'end_turn' as const,
    transportTrace: {
      request: { wire: 'request' },
      response: { wire: 'response' },
      status: 200,
      requestId: 'request-1',
    },
  }
  const inner: LlmClient = {
    provider: 'openai-agent',
    async chat() {
      return output
    },
  }
  const { createObservedLlmClient } = await import('./llm-observability.js')
  const client = createObservedLlmClient({
    client: inner,
    record: observation => observations.push(observation),
    now: (() => {
      const values = [
        new Date('2026-07-23T10:00:00.000Z'),
        new Date('2026-07-23T10:00:00.025Z'),
      ]
      return () => values.shift() ?? values.at(-1)!
    })(),
    id: () => 'call-1',
  })

  const input = {
    systemPrompt: 'system',
    messages: [{ role: 'user' as const, content: 'hello' }],
    tools: [],
    observation: { operation: 'agent.chat' as const, roundIndex: 4 },
  }
  const result = await client.chat(input)

  assert.equal(result, output)
  assert.deepEqual(observations, [{
    callId: 'call-1',
    ts: '2026-07-23T10:00:00.000Z',
    operation: 'agent.chat',
    roundIndex: 4,
    provider: 'openai-agent',
    model: 'test-model',
    status: 'completed',
    durationMs: 25,
    canonicalRequest: {
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    },
    wireRequest: { wire: 'request' },
    canonicalResponse: {
      content: 'done',
      toolCalls: [],
      usage: { inputTokens: 12, cachedTokens: 7, outputTokens: 3 },
      model: 'test-model',
      contextWindowTokens: 1000,
      stopReason: 'end_turn',
    },
    wireResponse: { wire: 'response' },
    requestId: 'request-1',
    httpStatus: 200,
    inputTokens: 12,
    cachedTokens: 7,
    outputTokens: 3,
    stopReason: 'end_turn',
    error: null,
  }])
})

test('observed LLM client records failure and rethrows the original error', async () => {
  const observations: LlmCallObservation[] = []
  const failure = Object.assign(new Error('provider unavailable'), {
    status: 503,
    requestId: 'request-failed',
    requestBody: { wire: 'failed-request' },
    responseText: '{"error":"unavailable"}',
  })
  const inner: LlmClient = {
    provider: 'claude-code',
    async chat() {
      throw failure
    },
  }
  const { createObservedLlmClient } = await import('./llm-observability.js')
  const client = createObservedLlmClient({
    client: inner,
    record: observation => observations.push(observation),
    now: (() => {
      const values = [
        new Date('2026-07-23T10:00:00.000Z'),
        new Date('2026-07-23T10:00:00.010Z'),
      ]
      return () => values.shift() ?? values.at(-1)!
    })(),
    id: () => 'call-failed',
  })

  await assert.rejects(
    client.chat({
      systemPrompt: 'system',
      messages: [],
      tools: [],
      observation: { operation: 'compaction' },
    }),
    error => error === failure,
  )

  assert.deepEqual(observations, [{
    callId: 'call-failed',
    ts: '2026-07-23T10:00:00.000Z',
    operation: 'compaction',
    roundIndex: null,
    provider: 'claude-code',
    model: 'unknown',
    status: 'failed',
    durationMs: 10,
    canonicalRequest: { systemPrompt: 'system', messages: [], tools: [] },
    wireRequest: { wire: 'failed-request' },
    canonicalResponse: null,
    wireResponse: '{"error":"unavailable"}',
    requestId: 'request-failed',
    httpStatus: 503,
    inputTokens: null,
    cachedTokens: null,
    outputTokens: null,
    stopReason: null,
    error: 'provider unavailable',
  }])
})

test('LLM observations redact credentials and image bytes before storage', async () => {
  const { sanitizeLlmCallObservation } = await import('./llm-observability.js')
  const sanitized = sanitizeLlmCallObservation({
    callId: 'call-redact',
    ts: '2026-07-23T10:00:00.000Z',
    operation: 'agent.chat',
    roundIndex: 1,
    provider: 'openai-agent',
    model: 'test-model',
    status: 'completed',
    durationMs: 1,
    canonicalRequest: {
      apiKey: 'secret',
      image: { type: 'base64', data: 'abcdefgh' },
    },
    wireRequest: { authorization: 'Bearer secret' },
    canonicalResponse: { content: 'ok' },
    wireResponse: null,
    requestId: null,
    httpStatus: 200,
    inputTokens: 1,
    cachedTokens: 0,
    outputTokens: 1,
    stopReason: 'end_turn',
    error: null,
  })

  assert.deepEqual(sanitized.canonicalRequest, {
    apiKey: '[redacted]',
    image: { type: 'base64', data: '[omitted 8 chars]' },
  })
  assert.deepEqual(sanitized.wireRequest, { authorization: '[redacted]' })
})
