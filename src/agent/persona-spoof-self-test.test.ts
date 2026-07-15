import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LlmCallInput, LlmCallOutput, LlmClient } from './llm-client.js'
import { PersonaSpoofSelfTestMismatchError, runPersonaSpoofSelfTest } from './persona-spoof-self-test.js'

function output(content: string): LlmCallOutput {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: null, cachedTokens: null, outputTokens: null },
    model: 'claude-sonnet-4-6',
    contextWindowTokens: 200_000,
  }
}

function clientFromAttempts(attempts: Array<Error | LlmCallOutput>): LlmClient {
  return {
    async chat(_input: LlmCallInput): Promise<LlmCallOutput> {
      const attempt = attempts.shift()
      if (!attempt) throw new Error('unexpected extra attempt')
      if (attempt instanceof Error) throw attempt
      return attempt
    },
  }
}

describe('runPersonaSpoofSelfTest', () => {
  test('retries transient LLM call failures before accepting a valid persona response', async () => {
    const retryEvents: number[] = []
    const sleeps: number[] = []
    const client = clientFromAttempts([
      new Error('connect ECONNREFUSED 127.0.0.1:8317'),
      new Error('overloaded_error: Overloaded'),
      output('喵我是小猫猫'),
    ])

    const result = await runPersonaSpoofSelfTest(client, {
      attempts: 3,
      delayMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      onRetry: ({ attempt }) => {
        retryEvents.push(attempt)
      },
    })

    assert.equal(result.content, '喵我是小猫猫')
    assert.deepEqual(retryEvents, [1, 2])
    assert.deepEqual(sleeps, [25, 25])
  })

  test('does not retry a completed response that indicates cliproxy cloak behavior', async () => {
    const retryEvents: number[] = []
    const client = clientFromAttempts([output('我是 Claude Code')])

    await assert.rejects(
      () =>
        runPersonaSpoofSelfTest(client, {
          attempts: 3,
          onRetry: ({ attempt }) => {
            retryEvents.push(attempt)
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof PersonaSpoofSelfTestMismatchError)
        assert.equal(err.content, '我是 Claude Code')
        return true
      },
    )
    assert.deepEqual(retryEvents, [])
  })
})
