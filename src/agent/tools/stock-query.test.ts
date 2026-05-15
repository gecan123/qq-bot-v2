import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createStockQueryTool, truncateJson } from './stock-query.js'
import type { ToolContext } from '../tool.js'
import type { BotEvent } from '../event.js'
import { InMemoryEventQueue } from '../event-queue.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

function makeMockFetcher(response: { status: number; body: string }): typeof fetch {
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(response.body, { status: response.status })
  }
}

function makeErrorFetcher(errorName: string): typeof fetch {
  return async () => {
    const err = new Error('fetch failed')
    err.name = errorName
    throw err
  }
}

const logEntries: string[] = []
const mockAppender = async (_path: string, line: string) => {
  logEntries.push(line)
}

function makeTool(fetcher: typeof fetch) {
  logEntries.length = 0
  return createStockQueryTool({
    fetcher,
    timeoutMs: 5000,
    apiUrl: 'http://localhost:9999',
    appender: mockAppender,
    logPath: '/dev/null',
  })
}

const sampleResults = [
  { symbol: 'AAPL', last_price: 299.64, volume: 23256643 },
  { symbol: 'AAPL', date: '2026-05-12', close: 294.8 },
  { symbol: 'AAPL', date: '2026-05-11', close: 291.5 },
]

describe('stock_query tool', () => {
  test('successful response returns results JSON', async () => {
    const body = JSON.stringify({ id: '123', results: sampleResults, provider: 'yfinance' })
    const tool = makeTool(makeMockFetcher({ status: 200, body }))
    const result = await tool.execute(
      { path: 'equity/price/quote', params: { symbol: 'AAPL' } },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content)
    assert.equal(Array.isArray(parsed), true)
    assert.equal(parsed[0].symbol, 'AAPL')
  })

  test('rejects paths not in whitelist', async () => {
    const tool = makeTool(makeMockFetcher({ status: 200, body: '{}' }))
    const parseResult = tool.schema.safeParse({
      path: 'equity/ownership/insider_trading',
      params: { symbol: 'AAPL' },
    })
    assert.equal(parseResult.success, false)
  })

  test('accepts all 10 whitelist paths', async () => {
    const tool = makeTool(makeMockFetcher({ status: 200, body: '{}' }))
    const paths = [
      'equity/price/quote',
      'equity/price/historical',
      'equity/profile',
      'equity/fundamental/income',
      'equity/fundamental/balance',
      'equity/fundamental/cash',
      'equity/fundamental/metrics',
      'equity/fundamental/dividends',
      'equity/estimates/consensus',
      'news/company',
    ]
    for (const path of paths) {
      const parseResult = tool.schema.safeParse({ path, params: { symbol: 'X' } })
      assert.equal(parseResult.success, true, `path "${path}" should be allowed`)
    }
  })

  test('defaults provider to yfinance when not specified', async () => {
    let capturedUrl = ''
    const fetcher: typeof fetch = async (url) => {
      capturedUrl = String(url)
      return new Response('{"results":[]}', { status: 200 })
    }
    const tool = makeTool(fetcher)
    await tool.execute(
      { path: 'equity/price/quote', params: { symbol: 'AAPL' } },
      makeCtx(),
    )
    assert.ok(capturedUrl.includes('provider=yfinance'))
  })

  test('does not override explicit provider', async () => {
    let capturedUrl = ''
    const fetcher: typeof fetch = async (url) => {
      capturedUrl = String(url)
      return new Response('{"results":[]}', { status: 200 })
    }
    const tool = makeTool(fetcher)
    await tool.execute(
      { path: 'equity/price/quote', params: { symbol: 'AAPL', provider: 'fmp' } },
      makeCtx(),
    )
    assert.ok(capturedUrl.includes('provider=fmp'))
    assert.ok(!capturedUrl.includes('provider=yfinance'))
  })

  test('connection refused → unreachable error', async () => {
    const tool = makeTool(makeErrorFetcher('TypeError'))
    const result = await tool.execute(
      { path: 'equity/price/quote', params: { symbol: 'AAPL' } },
      makeCtx(),
    )
    assert.ok(result.content.includes('OpenBB service unreachable'))
  })

  test('timeout → timeout error', async () => {
    const tool = makeTool(makeErrorFetcher('AbortError'))
    const result = await tool.execute(
      { path: 'equity/price/quote', params: { symbol: 'AAPL' } },
      makeCtx(),
    )
    assert.ok(result.content.includes('request timeout'))
  })

  test('404 → endpoint not found', async () => {
    const tool = makeTool(makeMockFetcher({ status: 404, body: '{"detail":"Not Found"}' }))
    const result = await tool.execute(
      { path: 'equity/profile', params: { symbol: 'AAPL' } },
      makeCtx(),
    )
    assert.ok(result.content.includes('endpoint not found'))
  })

  test('other HTTP error → includes status code', async () => {
    const tool = makeTool(makeMockFetcher({ status: 502, body: 'Bad Gateway' }))
    const result = await tool.execute(
      { path: 'equity/price/quote', params: { symbol: 'AAPL' } },
      makeCtx(),
    )
    assert.ok(result.content.includes('HTTP 502'))
  })

  test('empty results array → no data message', async () => {
    const body = JSON.stringify({ id: '123', results: [], provider: 'yfinance' })
    const tool = makeTool(makeMockFetcher({ status: 200, body }))
    const result = await tool.execute(
      { path: 'equity/price/quote', params: { symbol: 'AAPL' } },
      makeCtx(),
    )
    assert.ok(result.content.includes('No data returned for AAPL'))
  })

  test('logs fetch to ops log', async () => {
    const body = JSON.stringify({ id: '123', results: sampleResults, provider: 'yfinance' })
    const tool = makeTool(makeMockFetcher({ status: 200, body }))
    await tool.execute(
      { path: 'equity/price/quote', params: { symbol: 'AAPL' } },
      makeCtx(),
    )
    assert.equal(logEntries.length, 1)
    const entry = JSON.parse(logEntries[0])
    assert.equal(entry.source, 'stock_query')
    assert.ok(entry.url.includes('equity/price/quote'))
  })
})

describe('truncateJson', () => {
  test('returns original if under cap', () => {
    const json = '[{"a":1},{"b":2}]'
    assert.equal(truncateJson(json, 100), json)
  })

  test('array truncation finds last complete object', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ idx: i, value: 'x'.repeat(20) }))
    const json = JSON.stringify(items)
    const result = truncateJson(json, 200)
    assert.ok(result.endsWith(']'))
    assert.ok(result.includes('...truncated'))
    const beforeTrunc = result.split('\n')[0]
    assert.ok(beforeTrunc.endsWith(']'))
  })

  test('non-array truncation does character cut', () => {
    const json = '{"key":"' + 'x'.repeat(2000) + '"}'
    const result = truncateJson(json, 100)
    assert.ok(result.includes('...truncated at 100 chars'))
  })
})
