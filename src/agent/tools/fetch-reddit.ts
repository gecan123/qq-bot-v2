import { z } from 'zod'
import { XMLParser } from 'fast-xml-parser'
import type { Tool } from '../tool.js'
import { config } from '../../config/index.js'
import { logFetch } from '../../ops/fetch-log.js'
import { createLogger } from '../../logger.js'

const log = createLogger('TOOL_FETCH_REDDIT')

/** 工具实现层硬截断 (premise 6 in idle-fetch-mvp). LLM 看不到原始 RSS, 只看摘要列表。 */
const HARD_LIMIT = 10
const TITLE_MAX_CHARS = 80
const SUMMARY_MAX_CHARS = 120

const argsSchema = z.object({
  subreddit: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_]+$/, 'subreddit 名称只能含英数下划线')
    .optional()
    .describe('可选 subreddit 名 (不带 r/ 前缀). 缺省 = reddit 首页 RSS.'),
  sort: z
    .enum(['hot', 'top', 'new'])
    .default('hot')
    .describe('排序: hot / top / new. 默认 hot.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(HARD_LIMIT)
    .default(HARD_LIMIT)
    .describe(`返回前 N 条 (上限 ${HARD_LIMIT})`),
})

type Args = z.infer<typeof argsSchema>

export interface FetchRedditDeps {
  fetcher?: typeof fetch
  appender?: (path: string, line: string) => Promise<void>
  timeoutMs?: number
  logPath?: string
  /** UA 头, reddit 对默认 UA 越来越严. */
  userAgent?: string
  /** 测试注入. */
  now?: () => Date
}

const DEFAULT_USER_AGENT = 'qq-bot-v2/0.1 (+https://github.com/anonymous; idle-fetch MVP)'

interface RedditEntry {
  title: string
  link: string
  summary: string
  author?: string
  published?: string
}

/** 拼接 reddit RSS URL. 纯函数, 易测试. */
export function buildRedditRssUrl(subreddit: string | undefined, sort: 'hot' | 'top' | 'new'): string {
  if (subreddit) {
    return `https://www.reddit.com/r/${subreddit}/${sort}.rss`
  }
  if (sort === 'hot') {
    return 'https://www.reddit.com/.rss'
  }
  return `https://www.reddit.com/${sort}.rss`
}

/** Atom feed → entries. summary 里的 HTML tag 被简单剥掉。纯函数。 */
export function parseRedditAtom(xml: string): RedditEntry[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  })
  const parsed = parser.parse(xml) as {
    feed?: {
      entry?: unknown
    }
  }
  const rawEntries = parsed?.feed?.entry
  if (!rawEntries) return []

  const list = Array.isArray(rawEntries) ? rawEntries : [rawEntries]
  const result: RedditEntry[] = []

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>

    const title = pickText(entry.title)
    const summary = stripHtml(pickText(entry.summary))
    const link = pickLinkHref(entry.link)
    const author = pickAuthorName(entry.author)
    const published = pickText(entry.published)

    if (!title && !link) continue

    const item: RedditEntry = { title, link, summary }
    if (author) item.author = author
    if (published) item.published = published
    result.push(item)
  }

  return result
}

function pickText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj['#text'] === 'string') return obj['#text']
  }
  return ''
}

function pickLinkHref(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  const candidates = Array.isArray(value) ? value : [value]
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const obj = candidate as Record<string, unknown>
      const href = obj['@_href']
      if (typeof href === 'string' && href.length > 0) return href
    }
  }
  return ''
}

function pickAuthorName(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const author = value as Record<string, unknown>
  return pickText(author.name)
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max).trimEnd() + '…'
}

function formatEntries(entries: RedditEntry[], limit: number): string {
  const sliced = entries.slice(0, Math.min(limit, HARD_LIMIT))
  if (sliced.length === 0) {
    return '(没拿到任何条目, RSS 可能为空或被过滤)'
  }
  const lines: string[] = []
  for (const entry of sliced) {
    const title = clip(entry.title, TITLE_MAX_CHARS) || '(无标题)'
    const summary = clip(entry.summary, SUMMARY_MAX_CHARS)
    const link = entry.link || '(无链接)'
    if (summary) {
      lines.push(`- ${title} | ${link} | ${summary}`)
    } else {
      lines.push(`- ${title} | ${link}`)
    }
  }
  return lines.join('\n')
}

interface FetchRedditOutcome {
  status: number
  bytes: number
  body: string
  errorKind?: string
}

async function fetchRss(
  url: string,
  options: { fetcher: typeof fetch; userAgent: string; timeoutMs: number },
): Promise<FetchRedditOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await options.fetcher(url, {
      headers: { 'user-agent': options.userAgent, accept: 'application/atom+xml,text/xml' },
      signal: controller.signal,
    })
    const body = await response.text()
    return { status: response.status, bytes: Buffer.byteLength(body, 'utf8'), body }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      status: -1,
      bytes: 0,
      body: '',
      errorKind: aborted ? 'timeout' : 'network_error',
    }
  } finally {
    clearTimeout(timer)
  }
}

export function createFetchRedditTool(deps: FetchRedditDeps = {}): Tool<Args> {
  const fetcher = deps.fetcher ?? fetch
  const timeoutMs = deps.timeoutMs ?? config.fetchRedditTimeoutMs
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT
  const now = deps.now ?? (() => new Date())

  return {
    name: 'fetch_reddit',
    description: [
      `拉 reddit RSS, 仅返回前 ${HARD_LIMIT} 条简要 (标题 + 短摘要 + 链接).`,
      '想深读某一条 → 拿那条 url 调 fetch_url. 不要因为没给详情就反复调它换 limit, 最多 10 就是 10.',
      '用法: subreddit 不传 = reddit 首页, 传比如 "programming" 限定到该 sub. sort 可选 hot/top/new, 默认 hot.',
      '收到 [空闲提示] 时这是首选工具. 但有想法才发, 没意思的就咽下去继续 wait.',
      '暂时只支持 reddit, 别问其他站.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = rawArgs as Args
      const url = buildRedditRssUrl(args.subreddit, args.sort)
      const startedAt = Date.now()
      const outcome = await fetchRss(url, { fetcher, userAgent, timeoutMs })
      const durationMs = Date.now() - startedAt

      const toolCallId = `round-${ctx.roundIndex}` // 实际 toolCallId 在 BotLoopAgent 持有, 这里只能用 round 标记
      const baseLog = {
        ts: now().toISOString(),
        source: 'reddit',
        url,
        status: outcome.status,
        bytes: outcome.bytes,
        toolCallId,
        durationMs,
      }

      if (outcome.errorKind) {
        await logFetch(
          { ...baseLog, errorKind: outcome.errorKind },
          { path: deps.logPath, appender: deps.appender },
        )
        log.warn({ url, errorKind: outcome.errorKind }, 'fetch_reddit_failed')
        return {
          content: `[fetch_reddit 失败] ${url}: ${outcome.errorKind}. 可以换个 subreddit / 稍后再试 / 或直接 wait.`,
        }
      }

      if (outcome.status < 200 || outcome.status >= 300) {
        await logFetch(
          { ...baseLog, errorKind: `http_${outcome.status}` },
          { path: deps.logPath, appender: deps.appender },
        )
        return {
          content: `[fetch_reddit HTTP ${outcome.status}] ${url}. reddit 拒了, 可能 rate limit 或 sub 不存在. 别原地重试.`,
        }
      }

      let entries: RedditEntry[]
      try {
        entries = parseRedditAtom(outcome.body)
      } catch (err) {
        await logFetch(
          { ...baseLog, errorKind: 'parse_error' },
          { path: deps.logPath, appender: deps.appender },
        )
        log.warn({ url, err }, 'fetch_reddit_parse_failed')
        return { content: `[fetch_reddit 解析失败] ${url}: ${(err as Error).message}` }
      }

      await logFetch(baseLog, { path: deps.logPath, appender: deps.appender })

      const header = args.subreddit
        ? `[reddit /r/${args.subreddit} ${args.sort} — top ${Math.min(args.limit, entries.length)}/${entries.length}]`
        : `[reddit 首页 ${args.sort} — top ${Math.min(args.limit, entries.length)}/${entries.length}]`
      return {
        content: `${header}\n${formatEntries(entries, args.limit)}`,
      }
    },
  }
}

export const fetchRedditTool = createFetchRedditTool()
