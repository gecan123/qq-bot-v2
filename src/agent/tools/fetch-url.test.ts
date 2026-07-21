import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createFetchUrlTool, extractFromHtml } from './fetch-url.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import type { LlmClient } from '../llm-client.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }
}

function mockLlm(reply: string | (() => Promise<string>)): LlmClient {
  return {
    async chat() {
      const content = typeof reply === 'function' ? await reply() : reply
      return {
        content,
        toolCalls: [],
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }
    },
  }
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

const SAMPLE_HTML = `<!doctype html>
<html>
  <head>
    <title>Example article</title>
    <meta name="description" content="A short blurb describing the article."/>
  </head>
  <body>
    <nav>SKIP NAV</nav>
    <article>
      <h1>Why monorepos sometimes pay off</h1>
      <p>The argument for monorepos is dependency consistency.</p>
      <p>The argument against is build complexity at scale.</p>
    </article>
    <script>console.log('SKIP SCRIPT')</script>
  </body>
</html>`

describe('extractFromHtml', () => {
  test('pulls title, meta description, article text; drops scripts', () => {
    const r = extractFromHtml(SAMPLE_HTML)
    assert.equal(r.title, 'Example article')
    assert.equal(r.description, 'A short blurb describing the article.')
    assert.match(r.text, /monorepos sometimes pay off/)
    assert.match(r.text, /dependency consistency/)
    assert.equal(r.text.includes('SKIP SCRIPT'), false)
    assert.equal(r.text.includes('SKIP NAV'), false, 'nav stays out when article is preferred')
  })

  test('falls back to body text when no <article>/<main>', () => {
    const r = extractFromHtml('<html><body><p>Just a body</p></body></html>')
    assert.match(r.text, /Just a body/)
  })
})

describe('fetch_url tool — happy path', () => {
  test('HTML fetch + LLM summary + structured result + NDJSON line', async () => {
    const writes: string[] = []
    const tool = createFetchUrlTool({
      fetcher: async () => htmlResponse(SAMPLE_HTML),
      llm: mockLlm('单仓优势: 依赖一致; 劣势: 构建复杂度.'),
      appender: async (_p, line) => {
        writes.push(line)
      },
      logPath: '/tmp/test-fetch.ndjson',
    })
    const result = await tool.execute({ url: 'https://example.com/article' }, makeCtx())
    const payload = JSON.parse(result.content as string)
    assert.deepEqual(payload, {
      ok: true,
      source: 'url',
      url: 'https://example.com/article',
      status: 200,
      title: 'Example article',
      summary: '单仓优势: 依赖一致; 劣势: 构建复杂度.',
      truncated: false,
    })
    assert.deepEqual(result.outcome, { ok: true })
    assert.equal(writes.length, 1)
    const logged = JSON.parse(writes[0]!.trim())
    assert.equal(logged.source, 'url')
    assert.equal(logged.status, 200)
  })

  test('plain text (non-HTML) is summarized too', async () => {
    const tool = createFetchUrlTool({
      fetcher: async () =>
        new Response('plain notes about caching', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      llm: mockLlm('讲缓存的笔记.'),
      appender: async () => {},
    })
    const result = await tool.execute({ url: 'https://example.com/notes.txt' }, makeCtx())
    const payload = JSON.parse(result.content as string)
    assert.equal(payload.summary, '讲缓存的笔记.')
    assert.equal(payload.title, '')
  })
})

describe('fetch_url tool — hard truncation', () => {
  test('output cap: even if LLM returns 5000 chars, output ≤ 1500 chars', async () => {
    const longSummary = '汉'.repeat(5000)
    const tool = createFetchUrlTool({
      fetcher: async () => htmlResponse(SAMPLE_HTML),
      llm: mockLlm(longSummary),
      appender: async () => {},
    })
    const result = await tool.execute({ url: 'https://example.com/' }, makeCtx())
    assert.ok((result.content as string).length <= 1500, `output too long: ${(result.content as string).length}`)
    const payload = JSON.parse(result.content as string)
    assert.equal(payload.ok, true)
    assert.equal(payload.truncated, true)
  })

  test('input cap: huge HTML body is truncated to ≤ 8KB before sending to LLM', async () => {
    const huge = `<html><body><article>${'x'.repeat(50_000)}</article></body></html>`
    let receivedUserMessageBytes = 0
    const tool = createFetchUrlTool({
      fetcher: async () => htmlResponse(huge),
      llm: {
        async chat(input) {
          const last = input.messages[input.messages.length - 1]
          if (last && last.role === 'user') {
            receivedUserMessageBytes = Buffer.byteLength(last.content, 'utf8')
          }
          return {
            content: 'summary',
            toolCalls: [],
            usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      appender: async () => {},
    })
    await tool.execute({ url: 'https://example.com/' }, makeCtx())
    // text body itself ≤ 8KB, plus a few hundred bytes of header lines + prompt scaffold
    assert.ok(
      receivedUserMessageBytes <= 8 * 1024 + 1024,
      `LLM user message exceeds 8KB+slack budget: ${receivedUserMessageBytes}`,
    )
  })

  test('response body cap: 1MB body → only first 256KB read', async () => {
    const oneMb = 'a'.repeat(1024 * 1024)
    let bodyByteCount = 0
    const tool = createFetchUrlTool({
      fetcher: async () =>
        new Response(oneMb, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      llm: {
        async chat(input) {
          const last = input.messages[input.messages.length - 1]
          if (last && last.role === 'user') {
            bodyByteCount = Buffer.byteLength(last.content, 'utf8')
          }
          return {
            content: 'cap test',
            toolCalls: [],
            usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      appender: async () => {},
    })
    await tool.execute({ url: 'https://example.com/big' }, makeCtx())
    // After 256KB cap on body + 8KB cap on extracted text, the LLM payload should be small
    assert.ok(bodyByteCount <= 8 * 1024 + 1024, `body too big: ${bodyByteCount}`)
  })
})

describe('fetch_url tool — failure modes', () => {
  test('LLM throws → structured fallback returns truncated raw', async () => {
    const writes: string[] = []
    const tool = createFetchUrlTool({
      fetcher: async () => htmlResponse(SAMPLE_HTML),
      llm: {
        async chat() {
          throw new Error('llm 502')
        },
      },
      appender: async (_p, line) => {
        writes.push(line)
      },
    })
    const result = await tool.execute({ url: 'https://example.com/' }, makeCtx())
    const payload = JSON.parse(result.content as string)
    assert.equal(payload.ok, true)
    assert.equal(payload.code, 'summary_fallback')
    assert.equal(payload.title, 'Example article')
    assert.match(payload.fallback, /monorepos sometimes pay off/)
    assert.deepEqual(result.outcome, { ok: true, code: 'summary_fallback' })
    const logged = JSON.parse(writes[0]!.trim())
    assert.equal(logged.errorKind, 'summarize_failed')
  })

  test('HTTP 404 → error content + NDJSON status=404', async () => {
    const writes: string[] = []
    const tool = createFetchUrlTool({
      fetcher: async () => htmlResponse('not found', 404),
      llm: mockLlm('unused'),
      appender: async (_p, line) => {
        writes.push(line)
      },
    })
    const result = await tool.execute({ url: 'https://example.com/missing' }, makeCtx())
    const payload = JSON.parse(result.content as string)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'http_error')
    assert.equal(payload.status, 404)
    assert.deepEqual(result.outcome, { ok: false, code: 'http_error', progress: false })
    const logged = JSON.parse(writes[0]!.trim())
    assert.equal(logged.status, 404)
    assert.equal(logged.errorKind, 'http_404')
  })

  test('timeout → errorKind=timeout, no summary attempt', async () => {
    let llmCalled = false
    const writes: string[] = []
    const tool = createFetchUrlTool({
      timeoutMs: 5,
      fetcher: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
      llm: {
        async chat() {
          llmCalled = true
          return {
            content: '',
            toolCalls: [],
            usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      appender: async (_p, line) => {
        writes.push(line)
      },
    })
    const result = await tool.execute({ url: 'https://example.com/' }, makeCtx())
    const payload = JSON.parse(result.content as string)
    assert.equal(payload.code, 'timeout')
    assert.deepEqual(result.outcome, { ok: false, code: 'timeout' })
    assert.equal(llmCalled, false)
    const logged = JSON.parse(writes[0]!.trim())
    assert.equal(logged.errorKind, 'timeout')
  })

  test('empty extracted content → does not call LLM', async () => {
    let llmCalled = false
    const tool = createFetchUrlTool({
      fetcher: async () =>
        htmlResponse('<html><body><script>only scripts</script></body></html>'),
      llm: {
        async chat() {
          llmCalled = true
          return {
            content: '',
            toolCalls: [],
            usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      appender: async () => {},
    })
    const result = await tool.execute({ url: 'https://example.com/empty' }, makeCtx())
    const payload = JSON.parse(result.content as string)
    assert.equal(payload.code, 'empty_content')
    assert.deepEqual(result.outcome, { ok: false, code: 'empty_content' })
    assert.equal(llmCalled, false)
  })

  test('rejects non-URL string via Zod', () => {
    const tool = createFetchUrlTool({
      fetcher: async () => htmlResponse(SAMPLE_HTML),
      llm: mockLlm('x'),
    })
    const r = tool.schema.safeParse({ url: 'not a url' })
    assert.equal(r.success, false)
  })
})
