import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type OpenAI from 'openai'
import { z } from 'zod'
import {
  createOpenAIChatFn,
  createAgentOpenAIConfig,
  parseToolCalls,
  toOpenAIMessages,
  toOpenAITools,
} from './openai-compat.js'

function makeFakeClient(
  handler: (request: unknown) => unknown,
): OpenAI {
  return {
    chat: {
      completions: {
        create: async (request: unknown) => handler(request),
      },
    },
  } as unknown as OpenAI
}

describe('toOpenAIMessages', () => {
  test('converts system prompt, tool calls, and tool results to OpenAI chat messages', () => {
    const messages = toOpenAIMessages('system', [
      { role: 'user', content: 'hello' },
      {
        role: 'tool_calls',
        calls: [{ id: 'call_1', name: 'search_web', args: { q: 'qq bot' } }],
      },
      {
        role: 'tool_results',
        results: [{ callId: 'call_1', name: 'search_web', output: 'done' }],
      },
    ])

    assert.equal(messages[0]?.role, 'system')
    assert.deepEqual(messages[1], { role: 'user', content: 'hello' })
    assert.equal(messages[2]?.role, 'assistant')
    assert.equal(messages[2]?.content, null)
    assert.equal(messages[3]?.role, 'tool')
    assert.equal(messages[3]?.tool_call_id, 'call_1')
    assert.equal(messages[3]?.content, 'done')
  })
})

describe('toOpenAITools', () => {
  test('converts tool declarations to OpenAI function tools', () => {
    const tools = toOpenAITools([
      {
        name: 'final_answer',
        description: 'finish the reply',
        inputSchema: z.object({ replyText: z.string() }),
      },
    ])

    assert.equal(tools.length, 1)
    assert.equal(tools[0]?.type, 'function')
    assert.equal(tools[0]?.function.name, 'final_answer')
  })
})

describe('parseToolCalls', () => {
  test('parses function arguments json', () => {
    const calls = parseToolCalls([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'final_answer',
          arguments: '{"replyText":"ok"}',
        },
      },
    ])

    assert.deepEqual(calls, [{ id: 'call_1', name: 'final_answer', args: { replyText: 'ok' } }])
  })

  test('falls back to empty args for invalid json', () => {
    const calls = parseToolCalls([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'final_answer',
          arguments: '{invalid',
        },
      },
    ])

    assert.deepEqual(calls, [{ id: 'call_1', name: 'final_answer', args: {} }])
  })
})

describe('createAgentOpenAIConfig', () => {
  test('reads LLM_AGENT_* env vars with fallback to shared provider defaults', () => {
    const saved = {
      agentBase: process.env.LLM_AGENT_BASE_URL,
      agentKey: process.env.LLM_AGENT_API_KEY,
      agentModel: process.env.LLM_AGENT_MODEL,
      defaultProvider: process.env.LLM_DEFAULT_PROVIDER,
      providerUrl: process.env.LLM_PROVIDER_CLAUDE_URL,
      providerKey: process.env.LLM_PROVIDER_CLAUDE_API_KEY,
      llmModel: process.env.LLM_DEFAULT_MODEL,
      openaiBase: process.env.OPENAI_BASE_URL,
      openaiKey: process.env.OPENAI_API_KEY,
      openaiModel: process.env.OPENAI_MODEL,
    }

    try {
      process.env.LLM_AGENT_BASE_URL = 'http://agent-url/v1'
      process.env.LLM_AGENT_API_KEY = 'sk-agent'
      process.env.LLM_AGENT_MODEL = 'agent-model'
      delete process.env.OPENAI_BASE_URL
      delete process.env.OPENAI_API_KEY
      delete process.env.OPENAI_MODEL

      const config = createAgentOpenAIConfig()
      assert.equal(config.baseURL, 'http://agent-url/v1')
      assert.equal(config.apiKey, 'sk-agent')
      assert.equal(config.model, 'agent-model')
    } finally {
      if (saved.agentBase === undefined) delete process.env.LLM_AGENT_BASE_URL
      else process.env.LLM_AGENT_BASE_URL = saved.agentBase
      if (saved.agentKey === undefined) delete process.env.LLM_AGENT_API_KEY
      else process.env.LLM_AGENT_API_KEY = saved.agentKey
      if (saved.agentModel === undefined) delete process.env.LLM_AGENT_MODEL
      else process.env.LLM_AGENT_MODEL = saved.agentModel
      if (saved.defaultProvider === undefined) delete process.env.LLM_DEFAULT_PROVIDER
      else process.env.LLM_DEFAULT_PROVIDER = saved.defaultProvider
      if (saved.providerUrl === undefined) delete process.env.LLM_PROVIDER_CLAUDE_URL
      else process.env.LLM_PROVIDER_CLAUDE_URL = saved.providerUrl
      if (saved.providerKey === undefined) delete process.env.LLM_PROVIDER_CLAUDE_API_KEY
      else process.env.LLM_PROVIDER_CLAUDE_API_KEY = saved.providerKey
      if (saved.llmModel === undefined) delete process.env.LLM_DEFAULT_MODEL
      else process.env.LLM_DEFAULT_MODEL = saved.llmModel
      if (saved.openaiBase === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = saved.openaiBase
      if (saved.openaiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = saved.openaiKey
      if (saved.openaiModel === undefined) delete process.env.OPENAI_MODEL
      else process.env.OPENAI_MODEL = saved.openaiModel
    }
  })

  test('falls back to shared llm config when LLM_AGENT_* is unset', () => {
    const saved = {
      agentBase: process.env.LLM_AGENT_BASE_URL,
      agentKey: process.env.LLM_AGENT_API_KEY,
      agentModel: process.env.LLM_AGENT_MODEL,
      defaultProvider: process.env.LLM_DEFAULT_PROVIDER,
      providerUrl: process.env.LLM_PROVIDER_CLAUDE_URL,
      providerKey: process.env.LLM_PROVIDER_CLAUDE_API_KEY,
      llmModel: process.env.LLM_DEFAULT_MODEL,
    }

    try {
      delete process.env.LLM_AGENT_BASE_URL
      delete process.env.LLM_AGENT_API_KEY
      delete process.env.LLM_AGENT_MODEL
      process.env.LLM_DEFAULT_PROVIDER = 'claude'
      process.env.LLM_PROVIDER_CLAUDE_URL = 'http://shared-url/v1'
      process.env.LLM_PROVIDER_CLAUDE_API_KEY = 'sk-shared'
      process.env.LLM_DEFAULT_MODEL = 'shared-model'

      const config = createAgentOpenAIConfig()
      assert.equal(config.baseURL, 'http://shared-url/v1')
      assert.equal(config.apiKey, 'sk-shared')
      assert.equal(config.model, 'shared-model')
    } finally {
      if (saved.agentBase === undefined) delete process.env.LLM_AGENT_BASE_URL
      else process.env.LLM_AGENT_BASE_URL = saved.agentBase
      if (saved.agentKey === undefined) delete process.env.LLM_AGENT_API_KEY
      else process.env.LLM_AGENT_API_KEY = saved.agentKey
      if (saved.agentModel === undefined) delete process.env.LLM_AGENT_MODEL
      else process.env.LLM_AGENT_MODEL = saved.agentModel
      if (saved.defaultProvider === undefined) delete process.env.LLM_DEFAULT_PROVIDER
      else process.env.LLM_DEFAULT_PROVIDER = saved.defaultProvider
      if (saved.providerUrl === undefined) delete process.env.LLM_PROVIDER_CLAUDE_URL
      else process.env.LLM_PROVIDER_CLAUDE_URL = saved.providerUrl
      if (saved.providerKey === undefined) delete process.env.LLM_PROVIDER_CLAUDE_API_KEY
      else process.env.LLM_PROVIDER_CLAUDE_API_KEY = saved.providerKey
      if (saved.llmModel === undefined) delete process.env.LLM_DEFAULT_MODEL
      else process.env.LLM_DEFAULT_MODEL = saved.llmModel
    }
  })
})

describe('createOpenAIChatFn', () => {
  test('passes reasoning_effort when configured and returns parsed tool calls', async () => {
    const calls: unknown[] = []
    const client = makeFakeClient((request) => {
      calls.push(request)
      return {
        choices: [{
          message: {
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'final_answer',
                arguments: '{"replyText":"ok"}',
              },
            }],
          },
        }],
        model: 'gpt-5.1',
        usage: null,
      }
    })

    const chatFn = createOpenAIChatFn(client, 'gpt-5.1', { reasoningEffort: 'medium' })
    const result = await chatFn({
      systemPrompt: 'system',
      history: [{ role: 'user', content: 'hello' }],
      tools: [],
    })

    assert.equal((calls[0] as any).reasoning_effort, 'medium')
    assert.deepEqual(result, {
      type: 'tool_calls',
      calls: [{ id: 'call_1', name: 'final_answer', args: { replyText: 'ok' } }],
      model: 'gpt-5.1',
    })
  })

  test('omits reasoning_effort by default and trims text content', async () => {
    const calls: unknown[] = []
    const client = makeFakeClient((request) => {
      calls.push(request)
      return {
        choices: [{ message: { content: '  ok  ' } }],
        model: 'gpt-5.1',
        usage: null,
      }
    })

    const chatFn = createOpenAIChatFn(client, 'gpt-5.1')
    const result = await chatFn({
      systemPrompt: 'system',
      history: [{ role: 'user', content: 'hello' }],
      tools: [],
    })

    assert.equal('reasoning_effort' in (calls[0] as any), false)
    assert.deepEqual(result, { type: 'text', content: 'ok', model: 'gpt-5.1' })
  })
})
