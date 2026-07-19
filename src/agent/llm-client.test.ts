import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LlmClient } from './llm-client.js'

describe('createLlmClient provider routing', () => {
  test('allows openai-agent as a main agent provider', async () => {
    const originalDefaultProvider = process.env.LLM_DEFAULT_PROVIDER
    const originalDefaultModel = process.env.LLM_DEFAULT_MODEL
    const originalContextWindows = process.env.LLM_MODEL_CONTEXT_WINDOWS_JSON
    const originalOpenAIUrl = process.env.LLM_PROVIDER_OPENAI_URL
    const originalOpenAIKey = process.env.LLM_PROVIDER_OPENAI_API_KEY
    const originalDatabaseUrl = process.env.DATABASE_URL
    const originalNapcatWsUrl = process.env.NAPCAT_WS_URL
    const originalNapcatAccessToken = process.env.NAPCAT_ACCESS_TOKEN
    const originalSelfNumber = process.env.SELF_NUMBER
    process.env.LLM_DEFAULT_PROVIDER = 'openai-agent'
    process.env.LLM_DEFAULT_MODEL = 'gpt-5.1'
    process.env.LLM_MODEL_CONTEXT_WINDOWS_JSON = JSON.stringify({ 'gpt-5.1': 400_000 })
    process.env.LLM_PROVIDER_OPENAI_URL = 'http://127.0.0.1:8317/v1'
    process.env.LLM_PROVIDER_OPENAI_API_KEY = 'sk-local'
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    process.env.NAPCAT_WS_URL = 'ws://localhost:3001'
    process.env.NAPCAT_ACCESS_TOKEN = 'token'
    process.env.SELF_NUMBER = '789'
    try {
      const mod = await import(`./llm-client.js?openai-agent-route=${Date.now()}`)
      assert.doesNotThrow(() => mod.createLlmClient())
      assert.throws(
        () => mod.createLlmClient({ model: 'unregistered-model' }),
        /missing context-window metadata for model unregistered-model/,
      )
    } finally {
      restoreEnv('LLM_DEFAULT_PROVIDER', originalDefaultProvider)
      restoreEnv('LLM_DEFAULT_MODEL', originalDefaultModel)
      restoreEnv('LLM_MODEL_CONTEXT_WINDOWS_JSON', originalContextWindows)
      restoreEnv('LLM_PROVIDER_OPENAI_URL', originalOpenAIUrl)
      restoreEnv('LLM_PROVIDER_OPENAI_API_KEY', originalOpenAIKey)
      restoreEnv('DATABASE_URL', originalDatabaseUrl)
      restoreEnv('NAPCAT_WS_URL', originalNapcatWsUrl)
      restoreEnv('NAPCAT_ACCESS_TOKEN', originalNapcatAccessToken)
      restoreEnv('SELF_NUMBER', originalSelfNumber)
    }
  })
})

const request = {
  systemPrompt: 'system',
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: [],
}

describe('fallback llm client', () => {
  test('uses the fallback once after an exhausted overload/server failure', async () => {
    const { createFallbackLlmClient } = await import('./llm-client.js')
    const calls: string[] = []
    const primary: LlmClient = {
      async chat() {
        calls.push('primary')
        throw Object.assign(new Error('overloaded'), { kind: 'overloaded' })
      },
    }
    const fallback: LlmClient = {
      async chat() {
        calls.push('fallback')
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
          model: 'fallback-model',
          contextWindowTokens: 200_000,
          stopReason: 'end_turn',
        }
      },
    }

    const result = await createFallbackLlmClient({
      primary,
      fallback,
      primaryModel: 'primary-model',
      fallbackModel: 'fallback-model',
    }).chat(request)

    assert.deepEqual(calls, ['primary', 'fallback'])
    assert.equal(result.model, 'fallback-model')
  })

  test('does not fallback for auth, rate-limit, context, or invalid-request failures', async () => {
    const { createFallbackLlmClient } = await import('./llm-client.js')
    for (const kind of ['auth', 'rate_limit', 'context_overflow', 'invalid_request']) {
      let fallbackCalls = 0
      const error = Object.assign(new Error(kind), { kind })
      const client = createFallbackLlmClient({
        primary: { async chat() { throw error } },
        fallback: {
          async chat() {
            fallbackCalls++
            throw new Error('must not run')
          },
        },
        primaryModel: 'primary',
        fallbackModel: 'fallback',
      })

      await assert.rejects(client.chat(request), error)
      assert.equal(fallbackCalls, 0)
    }
  })

  test('recognizes generic OpenAI-style 5xx errors only when no stable kind exists', async () => {
    const { isLlmFallbackEligibleError } = await import('./llm-client.js')
    assert.equal(isLlmFallbackEligibleError({ status: 503 }), true)
    assert.equal(isLlmFallbackEligibleError({ status: 429 }), false)
    assert.equal(isLlmFallbackEligibleError({ status: 503, kind: 'auth' }), false)
  })

  test('distinguishes hard usage limits from ordinary temporary rate limits', async () => {
    const { isLlmUsageLimitError } = await import('./llm-client.js')
    assert.equal(isLlmUsageLimitError({ kind: 'rate_limit', message: 'too many requests' }), false)
    assert.equal(isLlmUsageLimitError({
      kind: 'rate_limit', message: 'organization usage limit exceeded',
    }), true)
    assert.equal(isLlmUsageLimitError({ code: 'insufficient_quota' }), true)
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
