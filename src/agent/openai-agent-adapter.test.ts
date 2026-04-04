import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { OpenAIAgentAdapter, createOpenAIAgentAdapter } from './openai-agent-adapter.js'

describe('OpenAIAgentAdapter', () => {
  test('chat includes reasoning_effort when configured', async () => {
    const calls: any[] = []
    const adapter = new OpenAIAgentAdapter('http://127.0.0.1:8317/v1', 'sk-local', 'gpt-5.1', {
      reasoningEffort: 'medium',
    })

    ;(adapter as any).client = {
      chat: {
        completions: {
          create: async (request: any) => {
            calls.push(request)
            return {
              choices: [{ message: { content: 'ok' } }],
              model: 'gpt-5.1',
            }
          },
        },
      },
    }

    await adapter.chat({
      systemPrompt: 'system',
      history: [{ role: 'user', content: 'hello' }],
      tools: [],
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].reasoning_effort, 'medium')
  })

  test('chat omits reasoning_effort by default', async () => {
    const calls: any[] = []
    const adapter = new OpenAIAgentAdapter('http://127.0.0.1:8317/v1', 'sk-local', 'gpt-5.1')

    ;(adapter as any).client = {
      chat: {
        completions: {
          create: async (request: any) => {
            calls.push(request)
            return {
              choices: [{ message: { content: 'ok' } }],
              model: 'gpt-5.1',
            }
          },
        },
      },
    }

    await adapter.chat({
      systemPrompt: 'system',
      history: [{ role: 'user', content: 'hello' }],
      tools: [],
    })

    assert.equal(calls.length, 1)
    assert.equal('reasoning_effort' in calls[0], false)
  })

  test('factory configures reasoning for reply generator only when requested', () => {
    const originalBaseUrl = process.env.LLM_AGENT_BASE_URL
    const originalApiKey = process.env.LLM_AGENT_API_KEY
    const originalModel = process.env.LLM_AGENT_MODEL

    process.env.LLM_AGENT_BASE_URL = 'http://127.0.0.1:8317/v1'
    process.env.LLM_AGENT_API_KEY = 'sk-local'
    process.env.LLM_AGENT_MODEL = 'gpt-5.1'

    try {
      const defaultAdapter = createOpenAIAgentAdapter()
      const replyAdapter = createOpenAIAgentAdapter({ reasoningEffort: 'medium' })

      assert.equal((defaultAdapter as any).reasoningEffort, undefined)
      assert.equal((replyAdapter as any).reasoningEffort, 'medium')
    } finally {
      if (originalBaseUrl === undefined) delete process.env.LLM_AGENT_BASE_URL
      else process.env.LLM_AGENT_BASE_URL = originalBaseUrl

      if (originalApiKey === undefined) delete process.env.LLM_AGENT_API_KEY
      else process.env.LLM_AGENT_API_KEY = originalApiKey

      if (originalModel === undefined) delete process.env.LLM_AGENT_MODEL
      else process.env.LLM_AGENT_MODEL = originalModel
    }
  })
})
