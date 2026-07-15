import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions/completions'
import { buildClaudeCodeRequestBody, type ClaudeMessageRequestBody } from './claude-code/request.js'
import { classifyProviderError, normalizeClaudeStopReason } from './claude-code/llm-client.js'
import {
  buildOpenAIAgentRequest,
  normalizeOpenAIError,
  normalizeOpenAIStopReason,
} from './openai-agent/llm-client.js'
import {
  providerOverflowFixture,
  providerReplayFixture,
  providerStopReasonFixtures,
} from './test-support/provider-replay-fixture.js'

interface ReplayProjection {
  toolNames: string[]
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>
  results: Array<{ id: string; text: string; imageCount: number }>
}

function buildOpenAI() {
  return buildOpenAIAgentRequest({
    model: 'gpt-fixture',
    ...providerReplayFixture,
    maxOutputTokens: 1234,
  })
}

function buildClaude() {
  return buildClaudeCodeRequestBody({
    model: 'claude-sonnet-4-fixture',
    ...providerReplayFixture,
    maxOutputTokens: 1234,
    thinking: { mode: 'adaptive', retention: 'active-tool-cycle' },
  })
}

function projectOpenAI(body: ChatCompletionCreateParamsNonStreaming): ReplayProjection {
  const calls: ReplayProjection['calls'] = []
  const results: ReplayProjection['results'] = []
  const imageCounts = new Map<string, number>()

  for (const message of body.messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        if (call.type !== 'function') continue
        calls.push({
          id: call.id,
          name: call.function.name,
          args: JSON.parse(call.function.arguments) as Record<string, unknown>,
        })
      }
    } else if (message.role === 'tool') {
      const text = typeof message.content === 'string' ? message.content : ''
      results.push({
        id: message.tool_call_id,
        text: text.replace('\n[图片见下一条 user image input]', ''),
        imageCount: 0,
      })
    } else if (message.role === 'user' && Array.isArray(message.content)) {
      const marker = message.content.find((part) => part.type === 'text')
      const match = marker?.type === 'text' ? /^\[tool result image: (.+)]$/.exec(marker.text) : null
      if (!match?.[1]) continue
      imageCounts.set(
        match[1],
        message.content.filter((part) => part.type === 'image_url').length,
      )
    }
  }
  for (const result of results) result.imageCount = imageCounts.get(result.id) ?? 0

  return {
    toolNames: (body.tools ?? []).flatMap((tool) => (
      tool.type === 'function' ? [tool.function.name] : []
    )),
    calls,
    results,
  }
}

function projectClaude(body: ClaudeMessageRequestBody): ReplayProjection {
  const calls: ReplayProjection['calls'] = []
  const results: ReplayProjection['results'] = []
  for (const message of body.messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        calls.push({
          id: String(block.id),
          name: String(block.name),
          args: block.input as Record<string, unknown>,
        })
      }
      if (block.type !== 'tool_result') continue
      const content = block.content
      if (typeof content === 'string') {
        results.push({ id: String(block.tool_use_id), text: content, imageCount: 0 })
        continue
      }
      const parts = Array.isArray(content) ? content as Array<Record<string, unknown>> : []
      results.push({
        id: String(block.tool_use_id),
        text: parts.filter((part) => part.type === 'text').map((part) => String(part.text)).join('\n'),
        imageCount: parts.filter((part) => part.type === 'image').length,
      })
    }
  }

  return {
    toolNames: (body.tools ?? []).map((tool) => String(tool.name)),
    calls,
    results,
  }
}

describe('provider replay conformance', () => {
  test('projects the same canonical tool cycle through OpenAI and Claude adapters', () => {
    const openAI = projectOpenAI(buildOpenAI())
    const claude = projectClaude(buildClaude())

    assert.deepEqual(openAI, claude)
    assert.deepEqual(openAI.calls.map((call) => call.id), ['call_lookup', 'call_image'])
    assert.deepEqual(openAI.results.map((result) => result.id), ['call_lookup', 'call_image'])
    assert.deepEqual(openAI.results.map((result) => result.imageCount), [0, 1])
    assert.deepEqual(
      new Set(openAI.results.map((result) => result.id)),
      new Set(openAI.calls.map((call) => call.id)),
      'the fixture must not serialize orphan tool results',
    )
  })

  test('is deterministic for both provider request builders', () => {
    assert.deepEqual(buildOpenAI(), buildOpenAI())
    assert.deepEqual(buildClaude(), buildClaude())
  })

  test('keeps provider-native thinking only on the Claude active tool cycle', () => {
    const openAI = buildOpenAI()
    const claude = buildClaude()
    const openAIAssistant = openAI.messages.find((message) => message.role === 'assistant')
    const claudeAssistant = claude.messages.find((message) => message.role === 'assistant')

    assert.equal(JSON.stringify(openAIAssistant).includes('fixture-signature'), false)
    assert.deepEqual(claudeAssistant?.content[0], {
      type: 'thinking',
      thinking: '先查询，再查看图片。',
      signature: 'fixture-signature',
    })
  })

  test('normalizes shared provider stop-reason fixtures to the same contract', () => {
    for (const fixture of providerStopReasonFixtures) {
      assert.equal(normalizeOpenAIStopReason(fixture.openAI), fixture.expected)
      assert.equal(normalizeClaudeStopReason(fixture.claude), fixture.expected)
    }
  })

  test('normalizes the shared overflow fixture to a non-retryable context overflow', () => {
    const openAIError = normalizeOpenAIError(
      {
        code: providerOverflowFixture.type,
        message: providerOverflowFixture.message,
      },
      providerOverflowFixture.contextWindowTokens,
    ) as { kind?: string; contextWindowTokens?: number }
    const claudeError = classifyProviderError(
      providerOverflowFixture.type,
      providerOverflowFixture.message,
    )

    assert.deepEqual(openAIError, {
      code: providerOverflowFixture.type,
      message: providerOverflowFixture.message,
      kind: 'context_overflow',
      contextWindowTokens: providerOverflowFixture.contextWindowTokens,
    })
    assert.deepEqual(claudeError, { kind: 'context_overflow', retryable: false })
  })
})
