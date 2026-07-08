import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

describe('createLlmClient provider routing', () => {
  test('allows openai-agent as a main agent provider', async () => {
    const originalDefaultProvider = process.env.LLM_DEFAULT_PROVIDER
    const originalDefaultModel = process.env.LLM_DEFAULT_MODEL
    const originalOpenAIUrl = process.env.LLM_PROVIDER_OPENAI_URL
    const originalOpenAIKey = process.env.LLM_PROVIDER_OPENAI_API_KEY
    const originalDatabaseUrl = process.env.DATABASE_URL
    const originalNapcatWsUrl = process.env.NAPCAT_WS_URL
    const originalNapcatAccessToken = process.env.NAPCAT_ACCESS_TOKEN
    const originalBotTargetGroupIds = process.env.BOT_TARGET_GROUP_IDS
    const originalSelfNumber = process.env.SELF_NUMBER
    process.env.LLM_DEFAULT_PROVIDER = 'openai-agent'
    process.env.LLM_DEFAULT_MODEL = 'gpt-5.1'
    process.env.LLM_PROVIDER_OPENAI_URL = 'http://127.0.0.1:8317/v1'
    process.env.LLM_PROVIDER_OPENAI_API_KEY = 'sk-local'
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    process.env.NAPCAT_WS_URL = 'ws://localhost:3001'
    process.env.NAPCAT_ACCESS_TOKEN = 'token'
    process.env.BOT_TARGET_GROUP_IDS = '123'
    process.env.SELF_NUMBER = '789'
    try {
      const mod = await import(`./llm-client.js?openai-agent-route=${Date.now()}`)
      assert.doesNotThrow(() => mod.createLlmClient())
    } finally {
      restoreEnv('LLM_DEFAULT_PROVIDER', originalDefaultProvider)
      restoreEnv('LLM_DEFAULT_MODEL', originalDefaultModel)
      restoreEnv('LLM_PROVIDER_OPENAI_URL', originalOpenAIUrl)
      restoreEnv('LLM_PROVIDER_OPENAI_API_KEY', originalOpenAIKey)
      restoreEnv('DATABASE_URL', originalDatabaseUrl)
      restoreEnv('NAPCAT_WS_URL', originalNapcatWsUrl)
      restoreEnv('NAPCAT_ACCESS_TOKEN', originalNapcatAccessToken)
      restoreEnv('BOT_TARGET_GROUP_IDS', originalBotTargetGroupIds)
      restoreEnv('SELF_NUMBER', originalSelfNumber)
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
