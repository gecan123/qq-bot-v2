import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createOpenbbCliTool, truncateOutput, type OpenbbCliRunner } from './openbb-cli.js'
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

function makeTool(runner: OpenbbCliRunner) {
  logEntries.length = 0
  return createOpenbbCliTool({
    runner,
    timeoutMs: 5000,
    appender: mockAppender,
    logPath: '/dev/null',
    now: () => new Date('2026-05-31T00:00:00.000Z'),
    clockMs: (() => {
      let t = 1000
      return () => t += 25
    })(),
  })
}

describe('openbb_cli tool', () => {
  test('accepts OpenBB CLI commands and rejects non-OpenBB shell commands', () => {
    const tool = makeTool(async () => ({ exitCode: 0, stdout: '[]', stderr: '', timedOut: false }))

    assert.equal(tool.schema.safeParse({
      command: '/equity/price/historical --symbol AAPL --provider yfinance',
    }).success, true)
    assert.equal(tool.schema.safeParse({
      command: 'equity/price/historical --symbol NVDA --provider yfinance\n/equity/fundamental/income --symbol NVDA --provider yfinance',
    }).success, true)
    assert.equal(tool.schema.safeParse({ command: 'curl https://example.com' }).success, false)
    assert.equal(tool.schema.safeParse({ command: '/equity/price/historical --symbol AAPL; rm -rf /' }).success, false)
    assert.equal(tool.schema.safeParse({ command: 'exe --file secrets' }).success, false)
  })

  test('successful command returns stdout and logs command metadata', async () => {
    const tool = makeTool(async (command, options) => {
      assert.equal(command, '/equity/price/historical --symbol AAPL --provider yfinance')
      assert.equal(options.timeoutMs, 5000)
      assert.equal(options.cliBin, 'openbb')
      return { exitCode: 0, stdout: '[{"symbol":"AAPL","last_price":299.64}]', stderr: '', timedOut: false }
    })

    const result = await tool.execute(
      { command: '/equity/price/historical --symbol AAPL --provider yfinance' },
      makeCtx(),
    )

    assert.equal(result.content, '[{"symbol":"AAPL","last_price":299.64}]')
    assert.equal(logEntries.length, 1)
    const entry = JSON.parse(logEntries[0])
    assert.equal(entry.source, 'openbb_cli')
    assert.equal(entry.url, '/equity/price/historical --symbol AAPL --provider yfinance')
    assert.equal(entry.status, 0)
    assert.equal(entry.bytes, 39)
  })

  test('returns exported JSON file content when OpenBB saves a file', async () => {
    const tool = createOpenbbCliTool({
      runner: async () => ({
        exitCode: 0,
        stdout: 'Loading...\nSaved file: /Users/zzz/OpenBBUserData/exports/quote.json',
        stderr: '',
        timedOut: false,
      }),
      fileReader: async (path) => {
        assert.equal(path, '/Users/zzz/OpenBBUserData/exports/quote.json')
        return '{"symbol":{"0":"AAPL"},"last_price":{"0":312.06}}'
      },
      timeoutMs: 5000,
      appender: mockAppender,
      logPath: '/dev/null',
    })

    const result = await tool.execute(
      { command: '/equity/price/quote --symbol AAPL --provider yfinance --export json' },
      makeCtx(),
    )

    assert.equal(
      result.content,
      JSON.stringify({
        exportedFile: '/Users/zzz/OpenBBUserData/exports/quote.json',
        rows: {
          offset: 0,
          limit: 50,
          returned: 1,
          total: 1,
        },
        columns: ['symbol', 'last_price'],
        data: [{ symbol: 'AAPL', last_price: 312.06 }],
      }),
    )
  })

  test('returns a requested row window for large exported JSON instead of blind truncation', async () => {
    const tool = createOpenbbCliTool({
      runner: async () => ({
        exitCode: 0,
        stdout: 'Saved file: /Users/zzz/OpenBBUserData/exports/history.json',
        stderr: '',
        timedOut: false,
      }),
      fileReader: async () => JSON.stringify({
        date: { 0: '2026-01-01', 1: '2026-01-02', 2: '2026-01-03' },
        close: { 0: 10, 1: 11, 2: 12 },
      }),
      timeoutMs: 5000,
      appender: mockAppender,
      logPath: '/dev/null',
    })

    const result = await tool.execute(
      {
        command: '/equity/price/historical --symbol AAPL --provider yfinance --export json',
        output: { rowOffset: 1, rowLimit: 2 },
      },
      makeCtx(),
    )

    assert.equal(
      result.content,
      JSON.stringify({
        exportedFile: '/Users/zzz/OpenBBUserData/exports/history.json',
        rows: {
          offset: 1,
          limit: 2,
          returned: 2,
          total: 3,
        },
        columns: ['date', 'close'],
        data: [
          { date: '2026-01-02', close: 11 },
          { date: '2026-01-03', close: 12 },
        ],
      }),
    )
  })

  test('non-zero exit returns structured error with stderr snippet', async () => {
    const tool = makeTool(async () => ({
      exitCode: 2,
      stdout: '',
      stderr: 'No such command: equity bad',
      timedOut: false,
    }))

    const result = await tool.execute(
      { command: '/equity/bad --symbol AAPL' },
      makeCtx(),
    )

    const parsed = JSON.parse(result.content as string)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.exitCode, 2)
    assert.equal(parsed.stderr, 'No such command: equity bad')
  })

  test('timeout returns structured error', async () => {
    const tool = makeTool(async () => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
    }))

    const result = await tool.execute(
      { command: '/equity/price/historical --symbol AAPL --provider yfinance' },
      makeCtx(),
    )

    assert.match(result.content as string, /command timeout/)
  })
})

describe('truncateOutput', () => {
  test('returns original output under cap', () => {
    assert.equal(truncateOutput('abc', 10), 'abc')
  })

  test('truncates long output with marker', () => {
    const result = truncateOutput('x'.repeat(20), 10)
    assert.equal(result, 'xxxxxxxxxx\n[...truncated at 10 chars]')
  })
})
