import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import {
  calculateRetryDelayMs,
  createClaudeCodeLlmClient,
  ClaudeCodeApiError,
  parseRetryAfterMs,
} from './llm-client.js'
import type { Tool } from '../tool.js'
import {
  ANTHROPIC_BETA,
  ANTHROPIC_VERSION,
  CLAUDE_CODE_USER_AGENT,
} from './headers.js'

const CLIPROXY_BASE_URL = 'http://127.0.0.1:8317/v1'
const CLIPROXY_API_KEY = 'sk-local'
const echoTool: Tool = {
  name: 'echo',
  description: 'Echo text',
  schema: z.object({ text: z.string() }),
  execute: async () => ({ content: 'ok' }),
}

function ev(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

const SAMPLE_TEXT_SSE =
  ev('message_start', {
    type: 'message_start',
    message: {
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 200 },
    },
  }) +
  ev('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }) +
  ev('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'hello' },
  }) +
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  ev('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 5 },
  })

function makeFetchMock(responses: Array<{ status?: number; body: string; headers?: HeadersInit }>): {
  fn: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const next = responses[i] ?? responses[responses.length - 1]
    if (!next) throw new Error('fetch mock ran out')
    i++
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(next.body, { status: next.status ?? 200, headers: next.headers })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const noWaitRetry = {
  sleep: async () => {},
  random: () => 0.5,
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resultWithin<T, U>(
  promise: Promise<T>,
  ms: number,
  timeoutValue: U,
): Promise<T | U> {
  return Promise.race([promise, delay(ms).then(() => timeoutValue)])
}

describe('ClaudeCodeLlmClient.chat', () => {
  test('forwards configured auto tool choice into the request body', async (t) => {
    const { fn, calls } = makeFetchMock([{ body: SAMPLE_TEXT_SSE }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'LongCat-2.0',
      contextWindowTokens: 200_000,
      baseURL: 'https://api.longcat.chat/anthropic/v1',
      apiKey: 'longcat-key',
      toolChoice: 'auto',
    })
    await client.chat({
      systemPrompt: 'persona',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [echoTool],
    })

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    assert.deepEqual(body.tool_choice, { type: 'auto' })
  })

  test('allows compaction to override configured any tool choice with auto', async (t) => {
    const { fn, calls } = makeFetchMock([{ body: SAMPLE_TEXT_SSE }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
      toolChoice: 'any',
    })
    await client.chat({
      systemPrompt: 'persona',
      messages: [{ role: 'user', content: 'compact this' }],
      tools: [echoTool],
      claudeToolChoice: 'auto',
    })

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    assert.deepEqual(body.tool_choice, { type: 'auto' })
  })

  test('forwards adaptive thinking mode and effort into the request body', async (t) => {
    const { fn, calls } = makeFetchMock([{ body: SAMPLE_TEXT_SSE }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
      toolChoice: 'any',
      thinking: { mode: 'adaptive', effort: 'max' },
    })
    await client.chat({
      systemPrompt: 'persona',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [echoTool],
    })

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(body.output_config, { effort: 'max' })
    assert.deepEqual(body.tool_choice, { type: 'auto' })
  })

  test('hits cliproxy localhost endpoint with correct cloak headers + Bearer apiKey', async (t) => {
    const { fn, calls } = makeFetchMock([{ body: SAMPLE_TEXT_SSE }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
    })
    await client.chat({ systemPrompt: 'persona', messages: [{ role: 'user', content: 'hi' }], tools: [] })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, `${CLIPROXY_BASE_URL}/messages?beta=true`)
    const headers = calls[0]?.init.headers as Record<string, string>
    assert.equal(headers.Authorization, `Bearer ${CLIPROXY_API_KEY}`)
    assert.equal(headers['Anthropic-Version'], ANTHROPIC_VERSION)
    assert.equal(headers['Anthropic-Beta'], ANTHROPIC_BETA)
    assert.equal(headers['User-Agent'], CLAUDE_CODE_USER_AGENT)
    assert.equal(headers['X-Stainless-Lang'], 'js')
    assert.equal(headers['X-Stainless-Runtime'], 'node')
  })

  test('parses text output + maps cache_read to cachedTokens', async (t) => {
    const { fn } = makeFetchMock([{ body: SAMPLE_TEXT_SSE }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
    })
    const out = await client.chat({
      systemPrompt: 'persona',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })
    assert.equal(out.content, 'hello')
    assert.equal(out.toolCalls.length, 0)
    assert.equal(out.usage.cachedTokens, 200)
    assert.equal(out.usage.outputTokens, 5)
    // inputTokens = uncached(50) + cache_read(200) + cache_create(0) = 250
    assert.equal(out.usage.inputTokens, 250)
    assert.equal(out.model, 'claude-sonnet-4-5')
    assert.equal(out.contextWindowTokens, 200_000)
    assert.equal(out.stopReason, 'end_turn')
  })

  test('forwards maxOutputTokens to max_tokens', async (t) => {
    const { fn, calls } = makeFetchMock([{ body: SAMPLE_TEXT_SSE }])
    t.mock.method(globalThis, 'fetch', fn)
    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
    })

    await client.chat({
      systemPrompt: 'persona',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxOutputTokens: 48_000,
    })

    const body = JSON.parse(String(calls[0]?.init.body)) as { max_tokens?: number }
    assert.equal(body.max_tokens, 48_000)
  })

  test('extracts toolCalls from tool_use stream blocks', async (t) => {
    const sse =
      ev('message_start', { type: 'message_start', message: { model: 'm' } }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'send_message' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"text":"hi"}' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 })
    const { fn } = makeFetchMock([{ body: sse }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'm',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
    })
    const out = await client.chat({
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })
    assert.equal(out.toolCalls.length, 1)
    assert.equal(out.toolCalls[0]?.id, 'tu_1')
    assert.equal(out.toolCalls[0]?.name, 'send_message')
    assert.deepEqual(out.toolCalls[0]?.args, { text: 'hi' })
  })

  test('maps thinking blocks to nativeBlocks and raw thinking log without adding to content', async (t) => {
    const sse =
      ev('message_start', { type: 'message_start', message: { model: 'claude-thinking-model' } }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'hidden reasoning' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig_1' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'send_message' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"text":"hi"}' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 1 })
    const { fn } = makeFetchMock([{ body: sse }])
    t.mock.method(globalThis, 'fetch', fn)
    const appended: Array<{ path: string; line: string }> = []
    let resolveLogWritten!: () => void
    const logWritten = new Promise<true>((resolve) => {
      resolveLogWritten = () => resolve(true)
    })

    const client = createClaudeCodeLlmClient({
      model: 'fallback-model',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
      thinkingLog: {
        mode: 'raw',
        path: 'tmp/thinking.ndjson',
        appender: async (path, line) => {
          appended.push({ path, line })
          resolveLogWritten()
        },
      },
    })

    const out = await client.chat({
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })
    assert.equal(await resultWithin(logWritten, 50, false), true)

    assert.deepEqual(out.nativeBlocks, [
      { type: 'thinking', thinking: 'hidden reasoning', signature: 'sig_1' },
    ])
    assert.equal(out.content.includes('hidden reasoning'), false)
    assert.equal(out.toolCalls.length, 1)
    assert.equal(out.toolCalls[0]?.id, 'tu_1')
    assert.equal(out.toolCalls[0]?.name, 'send_message')
    assert.deepEqual(out.toolCalls[0]?.args, { text: 'hi' })
    assert.equal(appended.length, 1)
    assert.equal(appended[0]?.path, 'tmp/thinking.ndjson')
    const line = JSON.parse(appended[0]?.line ?? '{}') as Record<string, unknown>
    assert.equal(line.model, 'claude-thinking-model')
    assert.equal(line.blockIndex, 0)
    assert.equal(line.type, 'thinking')
    assert.equal(line.thinking, 'hidden reasoning')
    assert.equal(line.signature, 'sig_1')
    assert.deepEqual(line.toolCallIds, ['tu_1'])
  })

  test('returns LLM output without waiting for thinking log appender completion', async (t) => {
    const sse =
      ev('message_start', { type: 'message_start', message: { model: 'claude-thinking-model' } }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'slow log text' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_slow', name: 'send_message' },
      }) +
      ev('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"text":"hi"}' },
      }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 1 })
    const { fn } = makeFetchMock([{ body: sse }])
    t.mock.method(globalThis, 'fetch', fn)

    let resolveAppender!: () => void
    const appenderCanFinish = new Promise<void>((resolve) => {
      resolveAppender = resolve
    })
    let resolveAppenderStarted!: () => void
    const appenderStarted = new Promise<true>((resolve) => {
      resolveAppenderStarted = () => resolve(true)
    })

    const client = createClaudeCodeLlmClient({
      model: 'fallback-model',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
      thinkingLog: {
        mode: 'raw',
        appender: async () => {
          resolveAppenderStarted()
          await appenderCanFinish
        },
      },
    })

    const chatPromise = client.chat({
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })
    assert.equal(await resultWithin(appenderStarted, 50, false), true)

    const out = await resultWithin(chatPromise, 50, null)
    assert.notEqual(out, null)
    assert.deepEqual(out?.nativeBlocks, [{ type: 'thinking', thinking: 'slow log text' }])
    assert.equal(out?.toolCalls[0]?.id, 'tu_slow')

    resolveAppender()
    await appenderCanFinish
  })

  test('non-retryable 400 throws structured ClaudeCodeApiError with full request/response context', async (t) => {
    const { fn, calls } = makeFetchMock([{
      status: 400,
      body: '{"error":{"type":"invalid_request_error","message":"bad input"}}',
      headers: { 'request-id': 'req-invalid' },
    }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'm',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
    })
    let caught: unknown
    try {
      await client.chat({
        systemPrompt: 's',
        messages: [{ role: 'user', content: 'h' }],
        tools: [],
      })
    } catch (err) {
      caught = err
    }
    assert.ok(caught instanceof ClaudeCodeApiError)
    assert.equal(caught.status, 400)
    assert.equal(caught.kind, 'invalid_request')
    assert.equal(caught.retryable, false)
    assert.equal(caught.providerErrorType, 'invalid_request_error')
    assert.equal(caught.requestId, 'req-invalid')
    assert.equal(calls.length, 1)
    // 完整 request body 应该挂在 error 上, 让 pino log {err} 时能直接 dump
    const reqBody = caught.requestBody as { system: Array<{ text: string }>; messages: unknown[] }
    assert.ok(Array.isArray(reqBody.system))
    assert.equal(reqBody.system.length, 2)
    assert.equal(reqBody.system[1]?.text, 's')
    assert.equal(reqBody.messages.length, 1)
  })

  test('classifies provider prompt-too-long responses for Runtime Host recovery without ordinary retry', async (t) => {
    const { fn, calls } = makeFetchMock([{
      status: 400,
      body: '{"error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens exceed the 200000 maximum"}}',
    }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'm',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
      retry: noWaitRetry,
    })

    await assert.rejects(
      () => client.chat({ systemPrompt: 's', messages: [{ role: 'user', content: 'h' }], tools: [] }),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeCodeApiError)
        assert.equal(err.kind, 'context_overflow')
        assert.equal(err.retryable, false)
        assert.equal((err as ClaudeCodeApiError & { contextWindowTokens?: number }).contextWindowTokens, 200_000)
        return true
      },
    )
    assert.equal(calls.length, 1)
  })

  test('transport failure retries once and returns the second response', async (t) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    let attempt = 0
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      attempt++
      if (attempt === 1) throw new TypeError('temporary network failure')
      return new Response(SAMPLE_TEXT_SSE, { status: 200 })
    }) as unknown as typeof fetch
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'LongCat-2.0',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
      retry: noWaitRetry,
    })
    const output = await client.chat({
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })

    assert.equal(output.content, 'hello')
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.init.body, calls[1]?.init.body)
  })

  test('transport failure is thrown after two retries', async (t) => {
    let calls = 0
    const fn = (async () => {
      calls++
      throw new TypeError('network remains unavailable')
    }) as unknown as typeof fetch
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'LongCat-2.0',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
      retry: noWaitRetry,
    })

    await assert.rejects(
      () => client.chat({ systemPrompt: 's', messages: [{ role: 'user', content: 'h' }], tools: [] }),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeCodeApiError)
        assert.equal(err.status, null)
        assert.equal(err.kind, 'transport')
        assert.equal(err.retryable, true)
        assert.equal(err.responseText, null)
        return true
      },
    )
    assert.equal(calls, 3)
  })

  test('529 honors retry-after and retries the same request body', async (t) => {
    const { fn, calls } = makeFetchMock([
      {
        status: 529,
        body: '{"error":{"type":"overloaded_error","message":"busy"}}',
        headers: { 'retry-after': '2', 'request-id': 'req-overloaded' },
      },
      { body: SAMPLE_TEXT_SSE },
    ])
    t.mock.method(globalThis, 'fetch', fn)
    const delays: number[] = []

    const client = createClaudeCodeLlmClient({
      model: 'm',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
      retry: {
        sleep: async (ms) => { delays.push(ms) },
        random: () => 0.5,
      },
    })
    const output = await client.chat({
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })

    assert.equal(output.content, 'hello')
    assert.deepEqual(delays, [2_000])
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.init.body, calls[1]?.init.body)
  })

  test('500 retries twice then preserves the final structured error', async (t) => {
    const { fn, calls } = makeFetchMock([{
      status: 500,
      body: '{"error":{"type":"api_error","message":"internal"}}',
      headers: { 'request-id': 'req-server' },
    }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'm',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
      retry: noWaitRetry,
    })

    await assert.rejects(
      () => client.chat({ systemPrompt: 's', messages: [{ role: 'user', content: 'h' }], tools: [] }),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeCodeApiError)
        assert.equal(err.kind, 'server')
        assert.equal(err.retryable, true)
        assert.equal(err.providerErrorType, 'api_error')
        assert.equal(err.requestId, 'req-server')
        return true
      },
    )
    assert.equal(calls.length, 3)
  })

  test('call-level abort cancels fetch without transport retry', async (t) => {
    let calls = 0
    const fn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason)
        }, { once: true })
      })
    }) as unknown as typeof fetch
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'LongCat-2.0',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
    })
    const controller = new AbortController()
    const pending = client.chat({
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
      signal: controller.signal,
    })
    controller.abort()

    await assert.rejects(pending, ClaudeCodeApiError)
    assert.equal(calls, 1)
  })

  test('401 不再做 forceRefresh 重试 - 直接抛 (cliproxy 端管 token)', async (t) => {
    const { fn, calls } = makeFetchMock([{ status: 401, body: '{"error":"unauthorized"}' }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
    })
    let caught: unknown
    try {
      await client.chat({ systemPrompt: 's', messages: [{ role: 'user', content: 'h' }], tools: [] })
    } catch (err) {
      caught = err
    }
    assert.ok(caught instanceof ClaudeCodeApiError)
    assert.equal(caught.status, 401)
    assert.equal(calls.length, 1)
  })

  test('SSE overloaded error retries instead of becoming an empty completion', async (t) => {
    const sse = ev('error', {
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'Overloaded',
      },
    })
    const { fn, calls } = makeFetchMock([{ body: sse }, { body: SAMPLE_TEXT_SSE }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-6',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
      retry: noWaitRetry,
    })

    const output = await client.chat({
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })
    assert.equal(output.content, 'hello')
    assert.equal(calls.length, 2)
  })

  test('retry delay parses seconds and HTTP-date and caps exponential jitter', () => {
    assert.equal(parseRetryAfterMs('1.5', 0), 1_500)
    assert.equal(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1_000), 4_000)
    assert.equal(parseRetryAfterMs('not-a-date', 0), null)
    assert.equal(calculateRetryDelayMs({
      attempt: 3,
      retryAfterMs: null,
      baseDelayMs: 500,
      maxDelayMs: 3_000,
      random: () => 0.5,
    }), 3_000)
    assert.equal(calculateRetryDelayMs({
      attempt: 0,
      retryAfterMs: 40_000,
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      random: () => 0.5,
    }), 30_000)
  })

  test('request body: stream:true, 2 system blocks, cache_control 1h 挂最后一块', async (t) => {
    const { fn, calls } = makeFetchMock([{ body: SAMPLE_TEXT_SSE }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-5',
      contextWindowTokens: 200_000,
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
    })
    await client.chat({
      systemPrompt: 'persona-XY',
      messages: [{ role: 'user', content: 'h' }],
      tools: [],
    })
    const body = JSON.parse(String(calls[0]?.init.body))
    assert.equal(body.stream, true)
    assert.equal('cache_control' in body, false)
    assert.equal(body.system.length, 2)
    assert.equal(body.system[1].text, 'persona-XY')
    assert.deepEqual(body.system[1].cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.equal(body.system[0].cache_control, undefined)
    assert.equal('tools' in body, false)
  })
})
