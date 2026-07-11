import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { createClaudeCodeLlmClient, ClaudeCodeApiError } from './llm-client.js'
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
  ev('message_delta', { type: 'message_delta', usage: { output_tokens: 5 } })

function makeFetchMock(responses: Array<{ status?: number; body: string }>): {
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
    return new Response(next.body, { status: next.status ?? 200 })
  }) as unknown as typeof fetch
  return { fn, calls }
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

  test('forwards adaptive thinking mode into the request body', async (t) => {
    const { fn, calls } = makeFetchMock([{ body: SAMPLE_TEXT_SSE }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-5',
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
      toolChoice: 'any',
      thinking: { mode: 'adaptive' },
    })
    await client.chat({
      systemPrompt: 'persona',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [echoTool],
    })

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(body.tool_choice, { type: 'auto' })
  })

  test('hits cliproxy localhost endpoint with correct cloak headers + Bearer apiKey', async (t) => {
    const { fn, calls } = makeFetchMock([{ body: SAMPLE_TEXT_SSE }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-5',
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

  test('non-2xx throws ClaudeCodeApiError with full request/response context (no retry)', async (t) => {
    const { fn, calls } = makeFetchMock([{ status: 500, body: '{"error":"internal"}' }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'm',
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
    assert.equal(caught.status, 500)
    assert.equal(caught.responseText, '{"error":"internal"}')
    // 不重试: 失败一次直接抛 (cliproxy 端管 token, bot 不刷新)
    assert.equal(calls.length, 1)
    // 完整 request body 应该挂在 error 上, 让 pino log {err} 时能直接 dump
    const reqBody = caught.requestBody as { system: Array<{ text: string }>; messages: unknown[] }
    assert.ok(Array.isArray(reqBody.system))
    assert.equal(reqBody.system.length, 2)
    assert.equal(reqBody.system[1]?.text, 's')
    assert.equal(reqBody.messages.length, 1)
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
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
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

  test('transport failure is thrown after one retry', async (t) => {
    let calls = 0
    const fn = (async () => {
      calls++
      throw new TypeError('network remains unavailable')
    }) as unknown as typeof fetch
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'LongCat-2.0',
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
    })

    await assert.rejects(
      () => client.chat({ systemPrompt: 's', messages: [{ role: 'user', content: 'h' }], tools: [] }),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeCodeApiError)
        assert.equal(err.status, null)
        assert.equal(err.responseText, null)
        return true
      },
    )
    assert.equal(calls, 2)
  })

  test('401 不再做 forceRefresh 重试 - 直接抛 (cliproxy 端管 token)', async (t) => {
    const { fn, calls } = makeFetchMock([{ status: 401, body: '{"error":"unauthorized"}' }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-5',
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

  test('SSE error event throws instead of becoming an empty completion', async (t) => {
    const sse = ev('error', {
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'Overloaded',
      },
    })
    const { fn } = makeFetchMock([{ body: sse }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-6',
      baseURL: CLIPROXY_BASE_URL,
      apiKey: CLIPROXY_API_KEY,
    })

    await assert.rejects(
      () => client.chat({ systemPrompt: 's', messages: [{ role: 'user', content: 'h' }], tools: [] }),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeCodeApiError)
        assert.equal(err.status, 200)
        assert.match(err.message, /overloaded_error/)
        assert.match(err.message, /Overloaded/)
        return true
      },
    )
  })

  test('request body: stream:true, 2 system blocks, cache_control 1h 挂最后一块', async (t) => {
    const { fn, calls } = makeFetchMock([{ body: SAMPLE_TEXT_SSE }])
    t.mock.method(globalThis, 'fetch', fn)

    const client = createClaudeCodeLlmClient({
      model: 'claude-sonnet-4-5',
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
