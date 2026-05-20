import { createLogger } from '../../logger.js'
import { logFetch } from '../../ops/fetch-log.js'
import type { ToolContext, ToolExecutionResult } from '../tool.js'
import { buildUrl, OUTPUT_CAP, truncateJson } from './stock-query.js'

const log = createLogger('TOOL_RSI')

const HISTORY_CALENDAR_DAYS = 120
const OUTPUT_ROWS = 20
const MIN_LENGTH = 2
const MAX_LENGTH = 50
const DEFAULT_LENGTH = 14

export const VIRTUAL_PATH_RSI = 'equity/technical/rsi' as const

export function computeRsi(closes: readonly number[], length: number = DEFAULT_LENGTH): number[] {
  const n = closes.length
  const rsi = new Array<number>(n).fill(NaN)
  if (n < length + 1) return rsi

  const gains = new Array<number>(n).fill(0)
  const losses = new Array<number>(n).fill(0)
  for (let i = 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains[i] = diff
    else losses[i] = -diff
  }

  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= length; i++) {
    avgGain += gains[i]
    avgLoss += losses[i]
  }
  avgGain /= length
  avgLoss /= length

  rsi[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  for (let i = length + 1; i < n; i++) {
    avgGain = (avgGain * (length - 1) + gains[i]) / length
    avgLoss = (avgLoss * (length - 1) + losses[i]) / length
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }

  return rsi
}

export interface HandleRsiDeps {
  readonly fetcher: typeof fetch
  readonly apiUrl: string
  readonly timeoutMs: number
  readonly logPath?: string
  readonly appender?: (path: string, line: string) => Promise<void>
  readonly now: () => Date
}

export async function handleRsi(
  params: Record<string, string>,
  deps: HandleRsiDeps,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const symbol = params.symbol
  if (!symbol) {
    return { content: JSON.stringify({ ok: false, error: 'symbol is required' }) }
  }

  const lengthRaw = params.length ?? String(DEFAULT_LENGTH)
  const length = Number(lengthRaw)
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
    return {
      content: JSON.stringify({
        ok: false,
        error: `length must be an integer between ${MIN_LENGTH} and ${MAX_LENGTH}, got "${lengthRaw}"`,
      }),
    }
  }

  const startDate = new Date(deps.now().getTime() - HISTORY_CALENDAR_DAYS * 86_400_000)
  const startDateStr = startDate.toISOString().slice(0, 10)

  const url = buildUrl(deps.apiUrl, 'equity/price/historical', {
    symbol,
    start_date: startDateStr,
  })

  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs)

  let status = -1
  let bodyText = ''
  let errorKind: string | undefined

  try {
    const response = await deps.fetcher(url, { signal: controller.signal })
    status = response.status
    bodyText = await response.text()
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    errorKind = aborted ? 'timeout' : 'connection_refused'
  } finally {
    clearTimeout(timer)
  }

  const durationMs = Date.now() - startedAt
  const baseLog = {
    ts: deps.now().toISOString(),
    source: 'stock_query_rsi',
    url,
    status,
    bytes: Buffer.byteLength(bodyText, 'utf8'),
    toolCallId: `round-${ctx.roundIndex}`,
    durationMs,
  }

  if (errorKind) {
    await logFetch(
      { ...baseLog, errorKind },
      { path: deps.logPath, appender: deps.appender },
    )
    const msg = errorKind === 'timeout' ? 'request timeout' : 'OpenBB service unreachable'
    log.warn({ url, errorKind }, 'rsi_fetch_failed')
    return { content: JSON.stringify({ ok: false, error: msg }) }
  }

  if (status < 200 || status >= 300) {
    await logFetch(
      { ...baseLog, errorKind: `http_${status}` },
      { path: deps.logPath, appender: deps.appender },
    )
    const snippet = bodyText.slice(0, 200)
    return { content: JSON.stringify({ ok: false, error: `HTTP ${status}: ${snippet}` }) }
  }

  await logFetch(baseLog, { path: deps.logPath, appender: deps.appender })

  let results: unknown[]
  try {
    const parsed = JSON.parse(bodyText)
    results = (parsed as Record<string, unknown>).results as unknown[]
    if (!Array.isArray(results)) {
      return { content: JSON.stringify({ ok: false, error: 'unexpected response shape' }) }
    }
  } catch {
    return { content: JSON.stringify({ ok: false, error: 'invalid JSON from historical endpoint' }) }
  }

  if (results.length < length + 1) {
    return {
      content: JSON.stringify({
        ok: false,
        error: `Not enough historical data for RSI (got ${results.length} rows, need at least ${length + 1})`,
      }),
    }
  }

  const rows = (results as Array<Record<string, unknown>>)
    .filter((r) => typeof r.date === 'string' && typeof r.close === 'number')
    .sort((a, b) => (a.date as string).localeCompare(b.date as string))

  const closes = rows.map((r) => r.close as number)
  const rsiValues = computeRsi(closes, length)

  const output: Array<{ date: string; close: number; rsi: number }> = []
  for (let i = rows.length - 1; i >= 0 && output.length < OUTPUT_ROWS; i--) {
    if (!Number.isNaN(rsiValues[i])) {
      output.unshift({
        date: rows[i].date as string,
        close: Math.round((rows[i].close as number) * 100) / 100,
        rsi: Math.round(rsiValues[i] * 100) / 100,
      })
    }
  }

  return { content: truncateJson(JSON.stringify(output), OUTPUT_CAP) }
}
