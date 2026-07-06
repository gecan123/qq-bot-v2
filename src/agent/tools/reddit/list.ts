import { z } from 'zod'
import type { Tool } from '../../tool.js'
import { config } from '../../../config/index.js'
import { logFetch } from '../../../ops/fetch-log.js'
import { createLogger } from '../../../logger.js'
import {
  DEFAULT_USER_AGENT,
  type RedditFetchDeps,
  fetchRedditRss,
  parseAtomXml,
  normalizeEntries,
  pickText,
  pickLinkHref,
  pickUrlAttr,
  pickAuthorName,
  stripHtml,
  clip,
  extractImageUrlFromHtml,
} from './shared.js'

const log = createLogger('TOOL_LIST_REDDIT')

/** 工具实现层硬截断 (premise 6 in idle-fetch-mvp). */
const HARD_LIMIT = 10
const TITLE_MAX_CHARS = 80
const SUMMARY_MAX_CHARS = 120
const OUTPUT_CAP_CHARS = 4000

const ALLOWED_SUBREDDITS = ['technology', 'ClaudeAI', 'OpenAI', 'wallstreetbets', 'memes'] as const
type AllowedSubreddit = (typeof ALLOWED_SUBREDDITS)[number]
const ALLOWED_SET = new Set<string>(ALLOWED_SUBREDDITS)

const argsSchema = z.object({
  subreddit: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((s): s is AllowedSubreddit => ALLOWED_SET.has(s), {
      message: `只允许这些 subreddit: ${ALLOWED_SUBREDDITS.join(', ')}`,
    })
    .describe(`subreddit 名 (可选值: ${ALLOWED_SUBREDDITS.join(' / ')}). 必填.`),
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

export interface RedditListEntry {
  title: string
  link: string
  summary: string
  imageUrl?: string
  author?: string
  published?: string
}

function clipField(value: string, max: number): string {
  return value.length <= max ? value : clip(value, max - 1)
}

/** 拼接 reddit RSS URL. 纯函数, 易测试. */
export function buildRedditRssUrl(
  subreddit: string | undefined,
  sort: 'hot' | 'top' | 'new',
): string {
  if (subreddit) return `https://www.reddit.com/r/${subreddit}/${sort}.rss`
  if (sort === 'hot') return 'https://www.reddit.com/.rss'
  return `https://www.reddit.com/${sort}.rss`
}

/** Atom feed → entries. summary 里的 HTML tag 被简单剥掉。纯函数。 */
export function parseRedditAtom(xml: string): RedditListEntry[] {
  const parsed = parseAtomXml(xml) as { feed?: { entry?: unknown } }
  const rawEntries = normalizeEntries(parsed?.feed?.entry)
  const result: RedditListEntry[] = []

  for (const entry of rawEntries) {
    const title = pickText(entry.title)
    const html = pickText(entry.content ?? entry.summary)
    const summary = stripHtml(html)
    const link = pickLinkHref(entry.link)
    const imageUrl = extractImageUrlFromHtml(html, pickUrlAttr(entry['media:thumbnail']))
    const author = pickAuthorName(entry.author)
    const published = pickText(entry.published)

    if (!title && !link) continue

    const item: RedditListEntry = { title, link, summary }
    if (imageUrl) item.imageUrl = imageUrl
    if (author) item.author = author
    if (published) item.published = published
    result.push(item)
  }
  return result
}

function formatEntries(entries: RedditListEntry[], limit: number): {
  items: Record<string, string>[]
  truncated: boolean
} {
  const sliced = entries.slice(0, Math.min(limit, HARD_LIMIT))
  let truncated = entries.length > sliced.length
  const items: Record<string, string>[] = []
  for (const entry of sliced) {
    const title = clipField(entry.title, TITLE_MAX_CHARS) || '(无标题)'
    const summary = clipField(entry.summary, SUMMARY_MAX_CHARS)
    const link = clipField(entry.link, 500)
    const item: Record<string, string> = { title, url: link, summary }
    if (entry.imageUrl) item.imageUrl = clipField(entry.imageUrl, 500)
    if (entry.author) item.author = clipField(entry.author, 80)
    if (entry.published) item.published = clipField(entry.published, 80)
    if (
      title !== (entry.title || '(无标题)')
      || summary !== entry.summary
      || link !== entry.link
      || item.imageUrl !== entry.imageUrl && entry.imageUrl !== undefined
      || item.author !== entry.author && entry.author !== undefined
      || item.published !== entry.published && entry.published !== undefined
    ) truncated = true
    items.push(item)
  }
  return { items, truncated }
}

function serializeListPayload(payload: {
  subreddit: string
  sort: string
  items: Record<string, string>[]
  truncated: boolean
}): string {
  const items = [...payload.items]
  let truncated = payload.truncated
  let content = JSON.stringify({ ok: true, source: 'reddit_list', ...payload, items, truncated })
  while (content.length > OUTPUT_CAP_CHARS && items.length > 0) {
    items.pop()
    truncated = true
    content = JSON.stringify({ ok: true, source: 'reddit_list', ...payload, items, truncated })
  }
  return content
}

export function createListRedditTool(deps: RedditFetchDeps = {}): Tool<Args> {
  const fetcher = deps.fetcher ?? fetch
  const timeoutMs = deps.timeoutMs ?? config.redditTimeoutMs
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT
  const now = deps.now ?? (() => new Date())

  return {
    name: 'list_reddit',
    description: [
      `列 reddit 帖子，以结构化 JSON 返回前 ${HARD_LIMIT} 条简要 (标题 + 链接 + 图片直链 + 短摘要).`,
      '想深读某条 → 拿那条链接调 fetch reddit post 看评论讨论. 别用 fetch url 走 reddit.',
      '如果输出里有 image: https://i.redd.it/... 这类直链 → 用 fetch image 下载, 再用 send_message 发送或 generate_image 编辑.',
      '不要因为没给详情就反复调本工具换 limit, 上限 10 就是 10.',
      `subreddit 必填, 只能传这几个: ${ALLOWED_SUBREDDITS.join(' / ')}. sort: hot/top/new, 默认 hot.`,
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = rawArgs as Args
      const url = buildRedditRssUrl(args.subreddit, args.sort)
      const startedAt = Date.now()
      const outcome = await fetchRedditRss(url, { fetcher, userAgent, timeoutMs })
      const durationMs = Date.now() - startedAt

      const baseLog = {
        ts: now().toISOString(),
        source: 'reddit_list',
        url,
        status: outcome.status,
        bytes: outcome.bytes,
        toolCallId: `round-${ctx.roundIndex}`,
        durationMs,
      }

      if (outcome.errorKind) {
        await logFetch(
          { ...baseLog, errorKind: outcome.errorKind },
          { path: deps.logPath, appender: deps.appender },
        )
        log.warn({ url, errorKind: outcome.errorKind }, 'list_reddit_failed')
        return {
          content: JSON.stringify({
            ok: false,
            source: 'reddit_list',
            url,
            code: outcome.errorKind,
            error: '抓取 Reddit 列表失败',
            status: outcome.status,
          }),
          outcome: { ok: false, code: outcome.errorKind },
        }
      }

      if (outcome.status < 200 || outcome.status >= 300) {
        await logFetch(
          { ...baseLog, errorKind: `http_${outcome.status}` },
          { path: deps.logPath, appender: deps.appender },
        )
        return {
          content: JSON.stringify({
            ok: false,
            source: 'reddit_list',
            url,
            code: 'http_error',
            error: 'Reddit 返回非成功状态',
            status: outcome.status,
          }),
          outcome: { ok: false, code: 'http_error' },
        }
      }

      let entries: RedditListEntry[]
      try {
        entries = parseRedditAtom(outcome.body)
      } catch (err) {
        await logFetch(
          { ...baseLog, errorKind: 'parse_error' },
          { path: deps.logPath, appender: deps.appender },
        )
        log.warn({ url, err }, 'list_reddit_parse_failed')
        return {
          content: JSON.stringify({
            ok: false,
            source: 'reddit_list',
            url,
            code: 'parse_error',
            error: clipField((err as Error).message, 300),
            status: outcome.status,
          }),
          outcome: { ok: false, code: 'parse_error' },
        }
      }

      await logFetch(baseLog, { path: deps.logPath, appender: deps.appender })

      const formatted = formatEntries(entries, args.limit)
      return {
        content: serializeListPayload({
          subreddit: args.subreddit,
          sort: args.sort,
          items: formatted.items,
          truncated: formatted.truncated,
        }),
        outcome: { ok: true },
      }
    },
  }
}
