import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { computeRsi, handleRsi } from './rsi.js'
import { createStockQueryTool } from './stock-query.js'
import type { ToolContext } from '../tool.js'
import type { BotEvent } from '../event.js'
import { InMemoryEventQueue } from '../event-queue.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

const logEntries: string[] = []
const mockAppender = async (_path: string, line: string) => {
  logEntries.push(line)
}

function makeHistoricalBody(rows: Array<{ date: string; close: number }>): string {
  return JSON.stringify({ id: 'test', results: rows, provider: 'yfinance' })
}

function generatePrices(
  start: number,
  count: number,
  step: number,
  baseDate = '2026-01-',
): Array<{ date: string; close: number }> {
  return Array.from({ length: count }, (_, i) => ({
    date: `${baseDate}${String(i + 1).padStart(2, '0')}`,
    close: start + i * step,
  }))
}

// ─── computeRsi pure function ────────────────────────────────────────────────

describe('computeRsi', () => {
  test('monotonically increasing prices → RSI approaches 100', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i)
    const rsi = computeRsi(closes, 14)
    for (let i = 0; i < 14; i++) {
      assert.ok(Number.isNaN(rsi[i]), `index ${i} should be NaN`)
    }
    for (let i = 14; i < rsi.length; i++) {
      assert.equal(rsi[i], 100, `index ${i} should be 100 (all gains)`)
    }
  })

  test('monotonically decreasing prices → RSI approaches 0', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 200 - i)
    const rsi = computeRsi(closes, 14)
    for (let i = 14; i < rsi.length; i++) {
      assert.equal(rsi[i], 0, `index ${i} should be 0 (all losses)`)
    }
  })

  test('alternating equal gains and losses → RSI near 50', () => {
    const closes: number[] = [100]
    for (let i = 1; i < 60; i++) {
      closes.push(closes[i - 1] + (i % 2 === 1 ? 5 : -5))
    }
    const rsi = computeRsi(closes, 14)
    const lastRsi = rsi[rsi.length - 1]
    assert.ok(lastRsi > 45 && lastRsi < 55, `expected ~50, got ${lastRsi}`)
  })

  test('not enough data → all NaN', () => {
    const rsi = computeRsi([100, 101, 102], 14)
    assert.equal(rsi.length, 3)
    for (const v of rsi) {
      assert.ok(Number.isNaN(v))
    }
  })

  test('exactly length+1 data points → one valid RSI value', () => {
    const closes = Array.from({ length: 15 }, (_, i) => 100 + i)
    const rsi = computeRsi(closes, 14)
    assert.ok(Number.isNaN(rsi[13]))
    assert.ok(!Number.isNaN(rsi[14]))
  })

  test('custom length=7', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i)
    const rsi = computeRsi(closes, 7)
    for (let i = 0; i < 7; i++) {
      assert.ok(Number.isNaN(rsi[i]))
    }
    assert.ok(!Number.isNaN(rsi[7]))
  })

  test('RSI values are always between 0 and 100', () => {
    const closes = [100, 105, 98, 110, 95, 120, 88, 115, 92, 108, 97, 113, 90, 107, 99, 111, 94, 116, 87, 109]
    const rsi = computeRsi(closes, 14)
    for (const v of rsi) {
      if (!Number.isNaN(v)) {
        assert.ok(v >= 0 && v <= 100, `RSI ${v} out of range`)
      }
    }
  })
})

// ─── handleRsi integration (via createStockQueryTool) ────────────────────────

describe('stock_query equity/technical/rsi', () => {
  function makeTool(fetcher: typeof fetch) {
    logEntries.length = 0
    return createStockQueryTool({
      fetcher,
      timeoutMs: 5000,
      apiUrl: 'http://localhost:9999',
      appender: mockAppender,
      logPath: '/dev/null',
      now: () => new Date('2026-05-20T12:00:00Z'),
    })
  }

  test('schema accepts equity/technical/rsi path', () => {
    const tool = makeTool(async () => new Response('{}', { status: 200 }))
    const result = tool.schema.safeParse({
      path: 'equity/technical/rsi',
      params: { symbol: 'NVDA' },
    })
    assert.equal(result.success, true)
  })

  test('happy path — returns RSI array', async () => {
    const rows = generatePrices(100, 60, 0.5)
    // Add some variation
    for (let i = 0; i < rows.length; i++) {
      rows[i] = { ...rows[i], close: rows[i].close + (i % 3 === 0 ? -2 : 1) }
    }
    const fetcher: typeof fetch = async () =>
      new Response(makeHistoricalBody(rows), { status: 200 })

    const tool = makeTool(fetcher)
    const result = await tool.execute(
      { path: 'equity/technical/rsi', params: { symbol: 'NVDA' } },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string)
    assert.ok(Array.isArray(parsed))
    assert.ok(parsed.length > 0 && parsed.length <= 20)
    for (const row of parsed) {
      assert.ok('date' in row && 'close' in row && 'rsi' in row)
      assert.ok(row.rsi >= 0 && row.rsi <= 100)
    }
  })

  test('fetches equity/price/historical with correct symbol', async () => {
    let capturedUrl = ''
    const rows = generatePrices(100, 30, 1)
    const fetcher: typeof fetch = async (url) => {
      capturedUrl = String(url)
      return new Response(makeHistoricalBody(rows), { status: 200 })
    }

    const tool = makeTool(fetcher)
    await tool.execute(
      { path: 'equity/technical/rsi', params: { symbol: 'TSLA' } },
      makeCtx(),
    )
    assert.ok(capturedUrl.includes('equity/price/historical'))
    assert.ok(capturedUrl.includes('symbol=TSLA'))
    assert.ok(capturedUrl.includes('start_date='))
  })

  test('custom length param', async () => {
    const rows = generatePrices(100, 40, 1)
    const fetcher: typeof fetch = async () =>
      new Response(makeHistoricalBody(rows), { status: 200 })

    const tool = makeTool(fetcher)
    const result = await tool.execute(
      { path: 'equity/technical/rsi', params: { symbol: 'AAPL', length: '7' } },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string)
    assert.ok(Array.isArray(parsed))
    assert.ok(parsed.length > 0)
  })

  test('missing symbol → error', async () => {
    const tool = makeTool(async () => new Response('{}', { status: 200 }))
    const result = await tool.execute(
      { path: 'equity/technical/rsi', params: {} },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.error.includes('symbol'))
  })

  test('invalid length → error', async () => {
    const tool = makeTool(async () => new Response('{}', { status: 200 }))
    const result = await tool.execute(
      { path: 'equity/technical/rsi', params: { symbol: 'X', length: '0' } },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.error.includes('length'))
  })

  test('insufficient historical data → error', async () => {
    const rows = generatePrices(100, 5, 1)
    const fetcher: typeof fetch = async () =>
      new Response(makeHistoricalBody(rows), { status: 200 })

    const tool = makeTool(fetcher)
    const result = await tool.execute(
      { path: 'equity/technical/rsi', params: { symbol: 'X' } },
      makeCtx(),
    )
    const parsed = JSON.parse(result.content as string)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.error.includes('Not enough'))
  })

  test('fetch timeout → error', async () => {
    const fetcher: typeof fetch = async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }

    const tool = makeTool(fetcher)
    const result = await tool.execute(
      { path: 'equity/technical/rsi', params: { symbol: 'X' } },
      makeCtx(),
    )
    assert.ok((result.content as string).includes('timeout'))
  })

  test('connection refused → error', async () => {
    const fetcher: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }

    const tool = makeTool(fetcher)
    const result = await tool.execute(
      { path: 'equity/technical/rsi', params: { symbol: 'X' } },
      makeCtx(),
    )
    assert.ok((result.content as string).includes('unreachable'))
  })

  test('logs fetch to ops log', async () => {
    const rows = generatePrices(100, 30, 1)
    const fetcher: typeof fetch = async () =>
      new Response(makeHistoricalBody(rows), { status: 200 })

    const tool = makeTool(fetcher)
    await tool.execute(
      { path: 'equity/technical/rsi', params: { symbol: 'NVDA' } },
      makeCtx(),
    )
    assert.equal(logEntries.length, 1)
    const entry = JSON.parse(logEntries[0])
    assert.equal(entry.source, 'stock_query_rsi')
  })
})
