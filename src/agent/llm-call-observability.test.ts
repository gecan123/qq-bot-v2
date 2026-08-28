import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LlmClient } from './llm-client.js'
import {
  attachLlmProviderEvidence,
  createLlmEvidenceDigest,
} from './llm-call-evidence.js'
import { observeLlmCall } from './llm-call-observability.js'
import type { TokenUsageEntry } from './token-stats.js'

describe('observeLlmCall', () => {
  test('records a content-free four-stage evidence chain for a successful provider call', async () => {
    const records: TokenUsageEntry[] = []
    const llm: LlmClient = {
      provider: 'claude-code',
      async chat() {
        return {
          content: 'private model answer',
          toolCalls: [{ id: 'call-1', name: 'inbox', args: { action: 'read' } }],
          usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 12 },
          model: 'claude-test',
          contextWindowTokens: 200_000,
          stopReason: 'tool_use',
          providerEvidence: {
            provider: 'claude-code',
            request: createLlmEvidenceDigest(
              { secret: 'wire request body' },
              {
                model: 'claude-test',
                messageCount: 2,
                contentBlockTypes: ['text', 'tool_result'],
                toolNames: ['inbox'],
                toolChoice: 'any',
                cacheBreakpointCount: 2,
              },
            ),
            response: createLlmEvidenceDigest(
              { secret: 'raw provider response' },
              {
                model: 'claude-test',
                contentBlockTypes: ['tool_use'],
                toolNames: ['inbox'],
                stopReason: 'tool_use',
              },
            ),
          },
        }
      },
    }

    const output = await observeLlmCall({
      llm,
      request: {
        systemPrompt: 'private system prompt',
        messages: [{ role: 'user', content: 'private user message' }],
        tools: [{
          name: 'inbox',
          description: 'read inbox',
          schema: {} as never,
          async execute() {
            return { content: '{}' }
          },
        }],
      },
      context: {
        operation: 'agent.chat',
        actor: 'main_agent',
        roundIndex: 7,
      },
      dependencies: {
        id: () => '11111111-1111-4111-8111-111111111111',
        nowMs: sequence(1_000, 1_125),
        record: entry => records.push(entry),
      },
    })

    assert.equal(output.model, 'claude-test')
    assert.equal(records.length, 1)
    assert.deepEqual(records[0], {
      callId: '11111111-1111-4111-8111-111111111111',
      operation: 'agent.chat',
      actor: 'main_agent',
      roundIndex: 7,
      provider: 'claude-code',
      status: 'succeeded',
      durationMs: 125,
      stopReason: 'tool_use',
      inputTokens: 100,
      cachedTokens: 80,
      outputTokens: 12,
      model: 'claude-test',
      evidence: {
        canonicalRequest: {
          fingerprint: records[0]?.evidence?.canonicalRequest.fingerprint,
          summary: {
            systemChars: 21,
            messageCount: 1,
            messageRoles: ['user'],
            toolNames: ['inbox'],
            cacheBreakpointCount: 0,
          },
        },
        providerRequest: llmEvidence(records, 'providerRequest'),
        providerResponse: llmEvidence(records, 'providerResponse'),
        canonicalResponse: {
          fingerprint: records[0]?.evidence?.canonicalResponse?.fingerprint,
          summary: {
            model: 'claude-test',
            contentChars: 20,
            contentBlockTypes: [],
            toolNames: ['inbox'],
            stopReason: 'tool_use',
          },
        },
      },
    })
    for (const digest of Object.values(records[0]?.evidence ?? {})) {
      assert.match(digest?.fingerprint ?? '', /^[a-f0-9]{64}$/)
    }
    assert.doesNotMatch(
      JSON.stringify(records[0]),
      /private system prompt|private user message|private model answer|wire request body|raw provider response/,
    )
  })

  test('records a failed request without persisting the error message', async () => {
    const records: TokenUsageEntry[] = []
    const providerRequest = createLlmEvidenceDigest(
      { prompt: 'private failed request' },
      { model: 'gpt-test', messageCount: 1, toolNames: ['send_message'] },
    )
    const error = Object.assign(new Error('secret upstream response'), {
      kind: 'server',
      status: 503,
    })
    attachLlmProviderEvidence(error, {
      provider: 'openai-agent',
      request: providerRequest,
    })
    const llm: LlmClient = {
      provider: 'openai-agent',
      async chat() {
        throw error
      },
    }

    await assert.rejects(
      observeLlmCall({
        llm,
        request: {
          systemPrompt: 'private',
          messages: [],
          tools: [],
        },
        context: {
          operation: 'compaction',
          actor: 'compactor',
        },
        dependencies: {
          id: () => '22222222-2222-4222-8222-222222222222',
          nowMs: sequence(2_000, 2_030),
          record: entry => records.push(entry),
        },
      }),
      error,
    )

    assert.equal(records.length, 1)
    assert.equal(records[0]?.status, 'failed')
    assert.equal(records[0]?.durationMs, 30)
    assert.equal(records[0]?.provider, 'openai-agent')
    assert.equal(records[0]?.model, 'gpt-test')
    assert.equal(records[0]?.errorKind, 'server')
    assert.equal(records[0]?.evidence?.providerRequest?.fingerprint, providerRequest.fingerprint)
    assert.doesNotMatch(JSON.stringify(records[0]), /secret upstream response|private failed request/)
  })
})

function sequence(...values: number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]!
}

function llmEvidence(
  records: TokenUsageEntry[],
  key: 'providerRequest' | 'providerResponse',
) {
  return records[0]?.evidence?.[key]
}
