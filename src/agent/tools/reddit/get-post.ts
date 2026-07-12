import { z } from 'zod'
import type { Tool } from '../../tool.js'
import { config } from '../../../config/index.js'
import { logFetch } from '../../../ops/fetch-log.js'
import { createLogger } from '../../../logger.js'
import { formatBeijingIso } from '../../../utils/beijing-time.js'
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
  collapseWhitespace,
  extractImageUrlFromHtml,
} from './shared.js'

const log = createLogger('TOOL_GET_REDDIT_POST')

/** 工具实现层硬截断. */
const COMMENT_BODY_MAX_CHARS = 200
const TOP_N_COMMENTS = 5
const OUTPUT_CAP_CHARS = 2000

/** /r/<sub>/comments/<post_id>(/<slug>?)?  -- 容许 slug, 末尾 / 可选, 容许 query/hash */
const REDDIT_POST_REGEX =
  /^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+(?:\/[^?#]*)?\/?(?:[?#].*)?$/

const argsSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => REDDIT_POST_REGEX.test(u), {
      message: 'url 必须是 reddit 帖子页 (形如 https://www.reddit.com/r/X/comments/POSTID/...)',
    })
    .describe('reddit 帖子链接, 通常从 fetch reddit list 输出里复制.'),
})

type Args = z.infer<typeof argsSchema>

export interface RedditPostDetail {
  title: string
  imageUrl?: string
  comments: { author: string; body: string }[]
}

function clipField(value: string, max: number): string {
  return value.length <= max ? value : clip(value, max - 1)
}

/** 把帖子页 URL 转成 .rss 端点. 纯函数. */
export function toRedditPostRssUrl(url: string): string {
  const stripped = url.replace(/[?#].*$/, '').replace(/\/+$/, '')
  return `${stripped}.rss`
}

/**
 * 单帖 RSS → 帖子标题 + 评论列表.
 *
 * reddit 的 /comments/POSTID.rss 返回 Atom feed:
 * - <feed><title> = 帖子标题 (有时带 "comments on:" 前缀)
 * - 第一条 t3_ entry 通常是帖子本身, 图片帖会在 content 里带原图链接
 * - 后续 t1_ entry = 评论 (content 是 HTML)
 */
export function parseRedditPostRss(xml: string): RedditPostDetail | null {
  const parsed = parseAtomXml(xml) as { feed?: { title?: unknown; entry?: unknown } }
  if (!parsed?.feed) return null

  const rawTitle = pickText(parsed.feed.title)
  if (!rawTitle) return null

  const entries = normalizeEntries(parsed.feed.entry)
  const comments: RedditPostDetail['comments'] = []
  let imageUrl = ''
  for (const entry of entries) {
    const entryId = pickText(entry.id)
    const html = pickText(entry.content ?? entry.summary)
    const entryImageUrl = extractImageUrlFromHtml(html, pickUrlAttr(entry['media:thumbnail']))
    if (!imageUrl && entryImageUrl) imageUrl = entryImageUrl

    if (entryId.startsWith('t3_')) continue

    const body = stripHtml(html)
    if (!body) continue
    comments.push({
      author: pickAuthorName(entry.author),
      body,
    })
    if (comments.length >= TOP_N_COMMENTS) break
  }

  return imageUrl ? { title: rawTitle, imageUrl, comments } : { title: rawTitle, comments }
}

function formatPost(detail: RedditPostDetail, sourceUrl: string): string {
  const url = clipField(sourceUrl, 500)
  const originalTitle = collapseWhitespace(detail.title)
  const title = clipField(originalTitle, 200)
  const imageUrl = detail.imageUrl ? clipField(detail.imageUrl, 500) : undefined
  const comments = detail.comments.map((comment) => {
    const body = collapseWhitespace(comment.body)
    return {
      author: clipField(comment.author || '(unknown)', 80),
      body: clipField(body, COMMENT_BODY_MAX_CHARS),
    }
  })
  let truncated = url !== sourceUrl || title !== originalTitle || imageUrl !== detail.imageUrl
    || detail.comments.some((comment, index) => (
      comments[index]!.author !== (comment.author || '(unknown)')
      || comments[index]!.body !== collapseWhitespace(comment.body)
    ))
  const render = () => JSON.stringify({
    ok: true,
    source: 'reddit_post',
    url,
    title,
    ...(imageUrl ? { imageUrl } : {}),
    comments,
    truncated,
  })
  let content = render()
  while (content.length > OUTPUT_CAP_CHARS && comments.length > 0) {
    comments.pop()
    truncated = true
    content = render()
  }
  return content
}

export function createGetRedditPostTool(deps: RedditFetchDeps = {}): Tool<Args> {
  const fetcher = deps.fetcher ?? fetch
  const timeoutMs = deps.timeoutMs ?? config.redditTimeoutMs
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT
  const now = deps.now ?? (() => new Date())

  return {
    name: 'get_reddit_post',
    description: [
      `以结构化 JSON 读取 reddit 一条帖子的 top ${TOP_N_COMMENTS} 评论 (输出 ≤ ${OUTPUT_CAP_CHARS} 字符).`,
      '典型: fetch reddit list 给了 10 条, 挑一条想深读的链接调本工具看评论讨论.',
      'url 必须是 reddit 帖子页 (含 /r/X/comments/POSTID/...). 其它站不接受, 走 fetch url.',
      `每条评论 ≤${COMMENT_BODY_MAX_CHARS} 字, 硬截断, 不能让本工具返回更长.`,
      '如果 RSS 带图片直链, 会输出 图片: https://i.redd.it/... 可交给 fetch image → generate_image.',
      'RSS 限制: 正文可用性不稳定, 主要看图片链接 + top 评论. fetch reddit list 的摘要里已有部分正文.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = rawArgs as Args
      const rssUrl = toRedditPostRssUrl(args.url)
      const startedAt = Date.now()
      const outcome = await fetchRedditRss(rssUrl, { fetcher, userAgent, timeoutMs })
      const durationMs = Date.now() - startedAt

      const baseLog = {
        ts: formatBeijingIso(now()),
        source: 'reddit_post',
        url: rssUrl,
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
        log.warn({ url: rssUrl, errorKind: outcome.errorKind }, 'get_reddit_post_failed')
        return {
          content: JSON.stringify({
            ok: false,
            source: 'reddit_post',
            url: clipField(args.url, 500),
            code: outcome.errorKind,
            error: '抓取 Reddit 帖子失败',
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
            source: 'reddit_post',
            url: clipField(args.url, 500),
            code: 'http_error',
            error: 'Reddit 返回非成功状态',
            status: outcome.status,
          }),
          outcome: { ok: false, code: 'http_error' },
        }
      }

      let detail: RedditPostDetail | null
      try {
        detail = parseRedditPostRss(outcome.body)
      } catch (err) {
        await logFetch(
          { ...baseLog, errorKind: 'parse_error' },
          { path: deps.logPath, appender: deps.appender },
        )
        log.warn({ url: rssUrl, err }, 'get_reddit_post_parse_failed')
        return {
          content: JSON.stringify({
            ok: false,
            source: 'reddit_post',
            url: clipField(args.url, 500),
            code: 'parse_error',
            error: clipField((err as Error).message, 300),
            status: outcome.status,
          }),
          outcome: { ok: false, code: 'parse_error' },
        }
      }

      if (!detail) {
        await logFetch(
          { ...baseLog, errorKind: 'empty_post' },
          { path: deps.logPath, appender: deps.appender },
        )
        return {
          content: JSON.stringify({
            ok: false,
            source: 'reddit_post',
            url: clipField(args.url, 500),
            code: 'empty_post',
            error: '响应中没有可解析的帖子结构',
            status: outcome.status,
          }),
          outcome: { ok: false, code: 'empty_post' },
        }
      }

      await logFetch(baseLog, { path: deps.logPath, appender: deps.appender })
      return { content: formatPost(detail, args.url), outcome: { ok: true } }
    },
  }
}
