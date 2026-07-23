import { describe, expect, it } from 'vitest'
import { timelineSnapshotSchema } from './timeline.schema.js'

describe('timeline DTO', () => {
  it('places LLM calls beside ledger, tool, and token events', async () => {
    const { buildTimelineSnapshot } = await import('./timeline.service.js')
    const snapshot = buildTimelineSnapshot({
      now: new Date('2026-07-23T10:05:00.000Z'),
      ledger: [],
      tools: [],
      tokens: [],
      llmCalls: [{
        id: 9n,
        callId: '62f168d4-24d7-4ab4-80eb-e97413c5d12c',
        ts: new Date('2026-07-23T10:00:00.000Z'),
        operation: 'agent.chat',
        roundIndex: 4,
        provider: 'openai-agent',
        model: 'gpt-test',
        status: 'completed',
        durationMs: 125,
        canonicalRequest: { messages: [{ role: 'user', content: 'hello' }] },
        wireRequest: { model: 'gpt-test' },
        canonicalResponse: { content: 'done' },
        wireResponse: { id: 'response-1' },
        requestId: 'request-1',
        httpStatus: 200,
        inputTokens: 12,
        cachedTokens: 8,
        outputTokens: 3,
        stopReason: 'end_turn',
        error: null,
      }],
    })

    expect(timelineSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(snapshot.summary.llmCalls).toBe(1)
    expect(snapshot.summary.failedLlmCalls).toBe(0)
    expect(snapshot.events).toMatchObject([{
      key: 'llm-9',
      kind: 'llm',
      title: 'agent.chat · gpt-test',
      detail: 'openai-agent · completed · 125ms · 12 in · 8 cached · 3 out',
      ok: true,
      roundIndex: 4,
      correlation: 'llmCallId',
    }])
    expect(snapshot.events[0]?.jsonDetail).toContain('"requestId": "request-1"')
    expect(snapshot.events[0]?.jsonDetail).toContain('"canonicalRequest"')
  })
})
