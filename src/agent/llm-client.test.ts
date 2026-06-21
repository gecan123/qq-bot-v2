import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

describe('createLlmClient provider routing', () => {
  test('allows openai-agent as a main agent provider', async () => {
    const originalDefaultProvider = process.env.LLM_DEFAULT_PROVIDER
    const originalDefaultModel = process.env.LLM_DEFAULT_MODEL
    const originalOpenAIUrl = process.env.LLM_PROVIDER_OPENAI_URL
    const originalOpenAIKey = process.env.LLM_PROVIDER_OPENAI_API_KEY
    process.env.LLM_DEFAULT_PROVIDER = 'openai-agent'
    process.env.LLM_DEFAULT_MODEL = 'gpt-5.1'
    process.env.LLM_PROVIDER_OPENAI_URL = 'http://127.0.0.1:8317/v1'
    process.env.LLM_PROVIDER_OPENAI_API_KEY = 'sk-local'
    try {
      const mod = await import(`./llm-client.js?openai-agent-route=${Date.now()}`)
      assert.doesNotThrow(() => mod.createLlmClient())
    } finally {
      restoreEnv('LLM_DEFAULT_PROVIDER', originalDefaultProvider)
      restoreEnv('LLM_DEFAULT_MODEL', originalDefaultModel)
      restoreEnv('LLM_PROVIDER_OPENAI_URL', originalOpenAIUrl)
      restoreEnv('LLM_PROVIDER_OPENAI_API_KEY', originalOpenAIKey)
    }
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
