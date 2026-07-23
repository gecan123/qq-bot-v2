import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions/completions'
import { createOpenAIAgentLlmClient } from './llm-client.js'

function createFakeClient(response: unknown, calls: ChatCompletionCreateParamsNonStreaming[] = []) {
  return {
    chat: {
      completions: {
        create: async (body: ChatCompletionCreateParamsNonStreaming) => {
          calls.push(body)
          return response as never
        },
      },
    },
  }
}

describe('openai-agent llm client', () => {
  test('returns wire request and response evidence for observability', async () => {
    const calls: ChatCompletionCreateParamsNonStreaming[] = []
    const response = {
      id: 'chatcmpl-1',
      model: 'gpt-5.1',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      _request_id: 'request-openai-1',
    }
    const client = createOpenAIAgentLlmClient({
      model: 'gpt-5.1',
      contextWindowTokens: 400_000,
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
      client: createFakeClient(response, calls),
    })

    const output = await client.chat({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })

    assert.equal(output.transportTrace?.request, calls[0])
    assert.equal(output.transportTrace?.response, response)
    assert.equal(output.transportTrace?.status, 200)
    assert.equal(output.transportTrace?.requestId, 'request-openai-1')
  })

  test('normalizes OpenAI context length errors for provider-neutral recovery', async () => {
    const client = createOpenAIAgentLlmClient({
      model: 'gpt-5.1',
      contextWindowTokens: 400_000,
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
      client: {
        chat: {
          completions: {
            async create() {
              throw Object.assign(new Error('maximum context length exceeded'), {
                code: 'context_length_exceeded',
              })
            },
          },
        },
      },
    })

    await assert.rejects(
      () => client.chat({ systemPrompt: 'system', messages: [], tools: [] }),
      (error: unknown) => {
        assert.equal((error as { kind?: string }).kind, 'context_overflow')
        assert.equal((error as { contextWindowTokens?: number }).contextWindowTokens, 400_000)
        return true
      },
    )
  })

  test('forwards a call-level abort signal to the OpenAI SDK', async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const client = createOpenAIAgentLlmClient({
      model: 'gpt-5.1',
      contextWindowTokens: 400_000,
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
      client: {
        chat: {
          completions: {
            async create(_body, options) {
              receivedSignal = options?.signal
              return {
                model: 'gpt-5.1',
                choices: [{ message: { role: 'assistant', content: 'ok' } }],
              } as never
            },
          },
        },
      },
    })

    await client.chat({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: controller.signal,
    })

    assert.equal(receivedSignal, controller.signal)
  })

  test('sends the same tool names and schemas through OpenAI function tools', async () => {
    const calls: ChatCompletionCreateParamsNonStreaming[] = []
    const client = createOpenAIAgentLlmClient({
      model: 'gpt-5.1',
      contextWindowTokens: 400_000,
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
      client: createFakeClient({
        model: 'gpt-5.1',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }, calls),
    })

    await client.chat({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'send_message',
          description: 'send to QQ',
          schema: z.object({ text: z.string() }),
          execute: async () => ({ content: 'unused' }),
        },
      ],
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.model, 'gpt-5.1')
    assert.equal(calls[0]!.tool_choice, 'required')
    assert.equal(calls[0]!.tools?.[0]?.type, 'function')
    assert.equal(calls[0]!.tools?.[0]?.function.name, 'send_message')
    assert.equal(calls[0]!.tools?.[0]?.function.description, 'send to QQ')
    assert.equal(calls[0]!.tools?.[0]?.function.strict, true)
    assert.deepEqual(calls[0]!.tools?.[0]?.function.parameters, {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    })
  })

  test('maps assistant tool calls and cached token usage back to LlmCallOutput', async () => {
    const client = createOpenAIAgentLlmClient({
      model: 'gpt-5.1',
      contextWindowTokens: 400_000,
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
      client: createFakeClient({
        model: 'gpt-5.1-2025-11-13',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: 'thinking',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'wait', arguments: '{"durationSeconds":30}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          total_tokens: 107,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    })

    const result = await client.chat({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })

    assert.equal(result.content, 'thinking')
    assert.deepEqual(result.toolCalls, [
      { id: 'call_1', name: 'wait', args: { durationSeconds: 30 } },
    ])
    assert.deepEqual(result.usage, {
      inputTokens: 100,
      cachedTokens: 80,
      outputTokens: 7,
    })
    assert.equal(result.model, 'gpt-5.1-2025-11-13')
    assert.equal(result.contextWindowTokens, 400_000)
    assert.equal(result.stopReason, 'tool_use')
  })

  test('maps length to max_tokens and forwards call-level output budget', async () => {
    const calls: ChatCompletionCreateParamsNonStreaming[] = []
    const client = createOpenAIAgentLlmClient({
      model: 'gpt-5.1',
      contextWindowTokens: 400_000,
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
      client: createFakeClient({
        model: 'gpt-5.1',
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'partial' } }],
      }, calls),
    })

    const result = await client.chat({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxOutputTokens: 9_000,
    })

    assert.equal(calls[0]?.max_completion_tokens, 9_000)
    assert.equal(result.stopReason, 'max_tokens')
  })

  test('normalizes strict-mode null optional tool arguments before returning tool calls', async () => {
    const client = createOpenAIAgentLlmClient({
      model: 'gpt-5.1',
      contextWindowTokens: 400_000,
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
      client: createFakeClient({
        model: 'gpt-5.1',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'send_message',
                    arguments: '{"target":{"type":"private","userId":3916147294},"text":"在的","image":null,"replyToMessageId":null}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    })

    const result = await client.chat({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'send_message',
          description: 'send',
          schema: z.object({
            target: z.object({
              type: z.literal('private'),
              userId: z.number(),
            }),
            text: z.string().optional(),
            image: z.object({ mediaId: z.number() }).optional(),
            replyToMessageId: z.number().optional(),
          }),
          execute: async () => ({ content: 'unused' }),
        },
      ],
    })

    assert.deepEqual(result.toolCalls, [
      {
        id: 'call_1',
        name: 'send_message',
        args: {
          target: { type: 'private', userId: 3916147294 },
          text: '在的',
        },
      },
    ])
  })

  test('serializes replayed assistant tool arguments with stable key order', async () => {
    const calls: ChatCompletionCreateParamsNonStreaming[] = []
    const client = createOpenAIAgentLlmClient({
      model: 'gpt-5.1',
      contextWindowTokens: 400_000,
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
      client: createFakeClient({
        model: 'gpt-5.1',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }, calls),
    })

    await client.chat({
      systemPrompt: 'system',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'call_order',
            name: 'db',
            args: { z: 1, a: { y: 2, b: 3 } },
          }],
        },
      ],
      tools: [],
    })

    const assistantMessage = calls[0]!.messages[1]
    if (assistantMessage?.role !== 'assistant') {
      assert.fail(`expected assistant message, got ${assistantMessage?.role}`)
    }
    const toolCall = assistantMessage.tool_calls?.[0]
    if (toolCall?.type !== 'function') {
      assert.fail(`expected function tool call, got ${toolCall?.type}`)
    }
    assert.equal(
      toolCall.function.arguments,
      '{"a":{"b":3,"y":2},"z":1}',
    )
  })

  test('keeps image tool results visible to OpenAI by converting them into user image parts', async () => {
    const calls: ChatCompletionCreateParamsNonStreaming[] = []
    const client = createOpenAIAgentLlmClient({
      model: 'gpt-5.1',
      contextWindowTokens: 400_000,
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'sk-local',
      client: createFakeClient({
        model: 'gpt-5.1',
        choices: [{ message: { role: 'assistant', content: 'seen' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }, calls),
    })

    await client.chat({
      systemPrompt: 'system',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_img', name: 'fetch_image', args: { action: 'url' } }],
        },
        {
          role: 'tool',
          toolCallId: 'call_img',
          content: [
            { type: 'text', text: '{"ok":true}' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'abc123',
              },
            },
          ],
        },
      ],
      tools: [],
    })

    const toolMessage = calls[0]!.messages.find((msg) => msg.role === 'tool')
    assert.deepEqual(toolMessage, {
      role: 'tool',
      tool_call_id: 'call_img',
      content: '{"ok":true}\n[图片见下一条 user image input]',
    })
    const imageMessage = calls[0]!.messages.at(-1)
    assert.deepEqual(imageMessage, {
      role: 'user',
      content: [
        { type: 'text', text: '[tool result image: call_img]' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
      ],
    })
  })
})
