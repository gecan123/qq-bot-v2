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
  pickAuthorName,
  stripHtml,
  clip,
} from './shared.js'

const log = createLogger('TOOL_LIST_REDDIT')

/** 工具实现层硬截断 (premise 6 in idle-fetch-mvp). */
const HARD_LIMIT = 10
const TITLE_MAX_CHARS = 80
const SUMMARY_MAX_CHARS = 120

const ALLOWED_SUBREDDITS = ['technology', 'ClaudeAI', 'OpenAI', 'wallstreetbets'] as const
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
  author?: string
  published?: string
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
    const summary = stripHtml(pickText(entry.summary))
    const link = pickLinkHref(entry.link)
    const author = pickAuthorName(entry.author)
    const published = pickText(entry.published)

    if (!title && !link) continue

    const item: RedditListEntry = { title, link, summary }
    if (author) item.author = author
    if (published) item.published = published
    result.push(item)
  }
  return result
}

function formatEntries(entries: RedditListEntry[], limit: number): string {
  const sliced = entries.slice(0, Math.min(limit, HARD_LIMIT))
  if (sliced.length === 0) return '(没拿到任何条目, RSS 可能为空或被过滤)'

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

export function createListRedditTool(deps: RedditFetchDeps = {}): Tool<Args> {
  const fetcher = deps.fetcher ?? fetch
  const timeoutMs = deps.timeoutMs ?? config.redditTimeoutMs
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT
  const now = deps.now ?? (() => new Date())

  return {
    name: 'list_reddit',
    description: [
      `列 reddit 帖子, 仅返回前 ${HARD_LIMIT} 条简要 (标题 + 链接 + 短摘要).`,
      '想深读某条 → 拿那条链接调 get_reddit_post 看评论讨论. 别用 fetch_url 走 reddit, 用专用工具.',
      '不要因为没给详情就反复调本工具换 limit, 上限 10 就是 10.',
      `subreddit 必填, 只能传这几个: ${ALLOWED_SUBREDDITS.join(' / ')}. sort: hot/top/new, 默认 hot.`,
      '收到 [空闲提示] 时这是首选工具. 但有想法才发, 没意思的就咽下去继续 wait.',
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
          content: `[list_reddit 失败] ${url}: ${outcome.errorKind}. 可换个 subreddit / 稍后再试 / 或直接 wait.`,
        }
      }

      if (outcome.status < 200 || outcome.status >= 300) {
        await logFetch(
          { ...baseLog, errorKind: `http_${outcome.status}` },
          { path: deps.logPath, appender: deps.appender },
        )
        return {
          content: `[list_reddit HTTP ${outcome.status}] ${url}. reddit 拒了, 可能 rate limit / sub 不存在. 别原地重试.`,
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
        return { content: `[list_reddit 解析失败] ${url}: ${(err as Error).message}` }
      }

      await logFetch(baseLog, { path: deps.logPath, appender: deps.appender })

      const sub = args.subreddit ? `/r/${args.subreddit}` : '首页'
      const header = `[reddit ${sub} ${args.sort} — top ${Math.min(args.limit, entries.length)}/${entries.length}]`
      return { content: `${header}\n${formatEntries(entries, args.limit)}` }
    },
  }
}

export const listRedditTool = createListRedditTool()
