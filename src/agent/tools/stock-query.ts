import { z } from 'zod'
import type { Tool } from '../tool.js'
import { config } from '../../config/index.js'
import { logFetch } from '../../ops/fetch-log.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_STOCK_QUERY')

const OUTPUT_CAP = 1500

const ALLOWED_PATHS = [
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
] as const

type AllowedPath = (typeof ALLOWED_PATHS)[number]
const ALLOWED_PATH_SET = new Set<string>(ALLOWED_PATHS)

const argsSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .refine((s): s is AllowedPath => ALLOWED_PATH_SET.has(s), {
      message: `只允许这些路径: ${ALLOWED_PATHS.join(', ')}`,
    })
    .describe(`OpenBB API 路径 (可选值: ${ALLOWED_PATHS.join(' / ')}). 必填.`),
  params: z
    .record(z.string(), z.string())
    .default({})
    .describe('查询参数, 如 {symbol: "AAPL", period: "annual"}. 至少传 symbol.'),
})

type Args = z.infer<typeof argsSchema>

export interface StockQueryDeps {
  fetcher?: typeof fetch
  timeoutMs?: number
  apiUrl?: string
  logPath?: string
  appender?: (path: string, line: string) => Promise<void>
  now?: () => Date
}

/**
 * JSON-aware 截断: 数组型响应找最后一个完整 `},` 闭合 `]`;
 * 非数组直接字符截断.
 */
export function truncateJson(raw: string, cap: number): string {
  if (raw.length <= cap) return raw

  const trimmed = raw.trimStart()
  if (trimmed.startsWith('[')) {
    const searchRegion = raw.slice(0, cap)
    const lastComplete = searchRegion.lastIndexOf('},')
    if (lastComplete > 0) {
      const kept = raw.slice(0, lastComplete + 1)
      const totalItems = (raw.match(/\{/g) ?? []).length
      const keptItems = (kept.match(/\{/g) ?? []).length
      return kept + `]\n[...truncated, showing ${keptItems} of ~${totalItems} items]`
    }
  }

  return raw.slice(0, cap) + '\n[...truncated at ' + cap + ' chars]'
}

function buildUrl(apiUrl: string, path: string, params: Record<string, string>): string {
  const url = new URL(`/api/v1/${path}`, apiUrl)
  if (!params.provider) {
    url.searchParams.set('provider', 'yfinance')
  }
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

export function createStockQueryTool(deps: StockQueryDeps = {}): Tool<Args> {
  const fetcher = deps.fetcher ?? fetch
  const timeoutMs = deps.timeoutMs ?? 15_000
  const apiUrl = deps.apiUrl ?? config.openbb?.apiUrl ?? 'http://localhost:8000'
  const now = deps.now ?? (() => new Date())

  return {
    name: 'stock_query',
    description: [
      '查股票 / 金融数据 (OpenBB REST API).',
      `path 必填, 只能传这些: ${ALLOWED_PATHS.join(' / ')}.`,
      'params 里至少传 symbol (如 "AAPL"). 不需要传 provider (默认 yfinance).',
      '想做深度分析就多调几次拿不同维度数据, 每次返回 ≤1500 字符.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = rawArgs as Args
      const url = buildUrl(apiUrl, args.path, args.params)
      const startedAt = Date.now()

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      let status = -1
      let bodyText = ''
      let errorKind: string | undefined

      try {
        const response = await fetcher(url, { signal: controller.signal })
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
        ts: now().toISOString(),
        source: 'stock_query',
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
        const msg = errorKind === 'timeout'
          ? 'request timeout'
          : 'OpenBB service unreachable'
        log.warn({ url, errorKind }, 'stock_query_failed')
        return { content: `{ok: false, error: "${msg}"}` }
      }

      if (status === 404) {
        await logFetch(
          { ...baseLog, errorKind: 'not_found' },
          { path: deps.logPath, appender: deps.appender },
        )
        return { content: '{ok: false, error: "endpoint not found"}' }
      }

      if (status < 200 || status >= 300) {
        await logFetch(
          { ...baseLog, errorKind: `http_${status}` },
          { path: deps.logPath, appender: deps.appender },
        )
        const snippet = bodyText.slice(0, 200)
        return { content: `{ok: false, error: "HTTP ${status}: ${snippet}"}` }
      }

      await logFetch(baseLog, { path: deps.logPath, appender: deps.appender })

      let parsed: unknown
      try {
        parsed = JSON.parse(bodyText)
      } catch {
        return { content: truncateJson(bodyText, OUTPUT_CAP) }
      }

      const results = (parsed as Record<string, unknown>)?.results
      if (Array.isArray(results) && results.length === 0) {
        const symbol = args.params.symbol ?? '(unknown)'
        return { content: `{ok: true, data: "No data returned for ${symbol}"}` }
      }

      const resultsJson = results != null
        ? JSON.stringify(results)
        : JSON.stringify(parsed)

      return { content: truncateJson(resultsJson, OUTPUT_CAP) }
    },
  }
}

export function maybeCreateStockQueryTool(): Tool<Args> | null {
  if (!config.openbb) return null
  return createStockQueryTool({ apiUrl: config.openbb.apiUrl })
}
