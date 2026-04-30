import { XMLParser } from 'fast-xml-parser'
import { load } from 'cheerio'
import { pollForumConnector, StaticForumFeedConnector, type ForumFeedConnector, type PollForumConnectorOptions } from './forum-connector.js'
import type { ForumReadItemInput, ForumReadSourceInput } from './forum-read-executor.js'

type FetchLike = (input: string, init?: {
  headers?: Record<string, string>
  signal?: AbortSignal
}) => Promise<{
  ok: boolean
  status: number
  statusText: string
  text(): Promise<string>
}>

export type V2exFeedTarget =
  | { type: 'latest' }
  | { type: 'node'; name: string }
  | { type: 'tab'; name: string }
  | { type: 'member'; name: string }
  | { type: 'url'; url: string; externalId?: string }

export interface V2exConnectorOptions {
  target?: V2exFeedTarget
  fetch?: FetchLike
  maxItems?: number
  timeoutMs?: number
  userAgent?: string
  interestKeywords?: string[]
  fetchDetails?: boolean
  detailReplyLimit?: number
}

export interface V2exPollingOptions extends PollForumConnectorOptions {
  enabled: boolean
  feeds: V2exFeedTarget[]
  intervalMs: number
  maxItemsPerFeed: number
  timeoutMs: number
  userAgent: string
  interestKeywords: string[]
  fetchDetails: boolean
  detailReplyLimit: number
  onError?: (error: unknown, target: V2exFeedTarget) => void
  onPoll?: (result: { target: V2exFeedTarget; itemCount: number; readCount: number }) => void
}

const V2EX_BASE_URL = 'https://www.v2ex.com'
const DEFAULT_USER_AGENT = 'qq-bot-v2 read-only forum connector (+https://www.v2ex.com)'
const DEFAULT_INTEREST_KEYWORDS = [
  'ai',
  'agent',
  'claude',
  'openai',
  'llm',
  'gpt',
  '编程',
  '程序员',
  '开发',
  '代码',
  '产品',
  '工具',
  '效率',
]

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  trimValues: true,
})

function arrayOf<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return textValue(record['#text']) ?? textValue(record['#cdata'])
}

function cleanText(value: unknown): string | undefined {
  const text = textValue(value)
  if (!text) return undefined
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || undefined
}

function clipText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact
}

function safeSlug(value: string): string {
  const slug = value.trim().replace(/^\/+|\/+$/g, '')
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(`invalid V2EX feed slug: ${value}`)
  }
  return slug
}

function targetExternalId(target: V2exFeedTarget): string {
  if (target.type === 'latest') return 'latest'
  if (target.type === 'url') return target.externalId ?? target.url
  return `${target.type}:${target.name}`
}

export function parseV2exFeedTarget(value: string): V2exFeedTarget {
  const raw = value.trim()
  if (!raw || raw === 'latest' || raw === 'index') return { type: 'latest' }
  if (raw.startsWith('node:')) return { type: 'node', name: safeSlug(raw.slice('node:'.length)) }
  if (raw.startsWith('tab:')) return { type: 'tab', name: safeSlug(raw.slice('tab:'.length)) }
  if (raw.startsWith('member:')) return { type: 'member', name: safeSlug(raw.slice('member:'.length)) }
  if (raw.startsWith('url:')) {
    const url = raw.slice('url:'.length).trim()
    const parsed = new URL(url)
    if (parsed.hostname !== 'www.v2ex.com' && parsed.hostname !== 'v2ex.com') {
      throw new Error(`V2EX custom feed URL must point to v2ex.com: ${url}`)
    }
    return { type: 'url', url: parsed.toString(), externalId: parsed.pathname.replace(/^\/+/, '') || parsed.hostname }
  }
  return { type: 'node', name: safeSlug(raw) }
}

export function parseV2exFeedTargets(value: string | undefined): V2exFeedTarget[] {
  if (!value?.trim()) return [{ type: 'latest' }]
  return value.split(',').map((item) => item.trim()).filter(Boolean).map(parseV2exFeedTarget)
}

export function buildV2exFeedUrl(target: V2exFeedTarget = { type: 'latest' }): string {
  if (target.type === 'latest') return `${V2EX_BASE_URL}/index.xml`
  if (target.type === 'node') return `${V2EX_BASE_URL}/feed/${safeSlug(target.name)}.xml`
  if (target.type === 'tab') return `${V2EX_BASE_URL}/feed/tab/${safeSlug(target.name)}.xml`
  if (target.type === 'member') return `${V2EX_BASE_URL}/feed/member/${safeSlug(target.name)}.xml`
  return target.url
}

function atomLink(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  for (const item of arrayOf(value)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const href = textValue(record['@_href'])
    if (href && (!record['@_rel'] || record['@_rel'] === 'alternate')) return href
  }
  return undefined
}

function parseDate(value: unknown): Date | null {
  const text = textValue(value)
  if (!text) return null
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date
}

function itemExternalId(item: Record<string, unknown>, link?: string, title?: string): string {
  return cleanText(item.guid) ?? cleanText(item.id) ?? link ?? `${title ?? 'untitled'}:${cleanText(item.pubDate) ?? ''}`
}

export function parseV2exRssItems(xml: string, maxItems = 20): ForumReadItemInput[] {
  const parsed = parser.parse(xml) as Record<string, unknown>
  const rss = parsed.rss as Record<string, unknown> | undefined
  const channel = rss?.channel as Record<string, unknown> | undefined
  const feed = parsed.feed as Record<string, unknown> | undefined
  const entries = arrayOf<Record<string, unknown>>(channel?.item as Record<string, unknown> | Record<string, unknown>[] | undefined)
    .concat(arrayOf(feed?.entry as Record<string, unknown> | Record<string, unknown>[] | undefined))

  return entries.slice(0, maxItems).flatMap((item) => {
    const title = cleanText(item.title)
    if (!title) return []
    const link = cleanText(item.link) ?? atomLink(item.link) ?? null
    return [{
      externalId: itemExternalId(item, link ?? undefined, title),
      url: link,
      title,
      author: cleanText(item.author) ?? cleanText(item['dc:creator']) ?? cleanText((item.author as Record<string, unknown> | undefined)?.name) ?? null,
      rawContent: cleanText(item.description) ?? cleanText(item['content:encoded']) ?? cleanText(item.summary) ?? null,
      publishedAt: parseDate(item.pubDate) ?? parseDate(item.published) ?? parseDate(item.updated),
    }]
  })
}

export function scoreV2exTitleInterest(
  title: string,
  keywords: string[] = DEFAULT_INTEREST_KEYWORDS,
): { interested: boolean; score: number; matchedKeywords: string[]; reason: string } {
  const normalizedTitle = title.toLowerCase()
  const normalizedKeywords = keywords.map((keyword) => keyword.trim()).filter(Boolean)
  if (normalizedKeywords.length === 0) {
    return {
      interested: true,
      score: 1,
      matchedKeywords: [],
      reason: 'empty keyword list means read all V2EX items',
    }
  }

  const matchedKeywords = normalizedKeywords.filter((keyword) => normalizedTitle.includes(keyword.toLowerCase()))
  return {
    interested: matchedKeywords.length > 0,
    score: matchedKeywords.length,
    matchedKeywords,
    reason: matchedKeywords.length > 0
      ? `title matched interest keyword(s): ${matchedKeywords.join(', ')}`
      : 'title did not match current interest keywords',
  }
}

export function extractV2exPostDetail(html: string, replyLimit = 20): {
  title?: string
  mainText?: string
  replies: string[]
  rawContent?: string
} {
  const $ = load(html)
  const title = clipText($('h1').first().text(), 240) || undefined
  const mainText = clipText($('.topic_content').first().text(), 6000) || undefined
  const replies = $('.reply_content')
    .toArray()
    .slice(0, Math.max(0, replyLimit))
    .map((element, index) => `${index + 1}. ${clipText($(element).text(), 1000)}`)
    .filter((text) => text.length > 3)

  const parts = [
    title ? `标题：${title}` : null,
    mainText ? `主帖：${mainText}` : null,
    replies.length > 0 ? `回帖摘录：\n${replies.join('\n')}` : null,
  ].filter(Boolean)

  return {
    title,
    mainText,
    replies,
    rawContent: parts.length > 0 ? parts.join('\n\n') : undefined,
  }
}

export class V2exRssConnector implements ForumFeedConnector {
  readonly source: ForumReadSourceInput
  readonly feedUrl: string
  private readonly fetchImpl: FetchLike
  private readonly maxItems: number
  private readonly timeoutMs: number
  private readonly userAgent: string
  private readonly interestKeywords: string[]
  private readonly fetchDetails: boolean
  private readonly detailReplyLimit: number

  constructor(options: V2exConnectorOptions = {}) {
    const target = options.target ?? { type: 'latest' }
    this.feedUrl = buildV2exFeedUrl(target)
    this.source = {
      kind: 'v2ex',
      externalId: targetExternalId(target),
      displayName: target.type === 'latest' ? 'V2EX Latest' : `V2EX ${targetExternalId(target)}`,
      config: {
        target,
        feedUrl: this.feedUrl,
        readOnly: true,
      },
    }
    this.fetchImpl = options.fetch ?? fetch
    this.maxItems = options.maxItems ?? 20
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT
    this.interestKeywords = options.interestKeywords ?? DEFAULT_INTEREST_KEYWORDS
    this.fetchDetails = options.fetchDetails ?? true
    this.detailReplyLimit = options.detailReplyLimit ?? 20
  }

  private async fetchText(url: string, accept: string): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: accept,
          'User-Agent': this.userAgent,
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`V2EX request failed: ${response.status} ${response.statusText}`)
      }
      return response.text()
    } finally {
      clearTimeout(timeout)
    }
  }

  private async enrichInterestedItem(item: ForumReadItemInput): Promise<ForumReadItemInput | null> {
    const interest = scoreV2exTitleInterest(item.title, this.interestKeywords)
    if (!interest.interested) return null

    const fallbackContent = [
      item.rawContent,
      `兴趣判断：${interest.reason}`,
    ].filter(Boolean).join('\n\n') || null

    if (!this.fetchDetails || !item.url) {
      return {
        ...item,
        rawContent: fallbackContent,
      }
    }

    try {
      const detailUrl = new URL(item.url)
      detailUrl.hash = ''
      const detail = extractV2exPostDetail(
        await this.fetchText(detailUrl.toString(), 'text/html, application/xhtml+xml;q=0.9'),
        this.detailReplyLimit,
      )
      return {
        ...item,
        title: detail.title ?? item.title,
        rawContent: [
          `兴趣判断：${interest.reason}`,
          detail.rawContent,
          item.rawContent ? `RSS 摘要：${item.rawContent}` : null,
        ].filter(Boolean).join('\n\n') || fallbackContent,
      }
    } catch (error) {
      return {
        ...item,
        rawContent: [
          fallbackContent,
          `详情抓取失败，使用 RSS 降级内容：${error instanceof Error ? error.message : String(error)}`,
        ].filter(Boolean).join('\n\n') || null,
      }
    }
  }

  async poll(): Promise<ForumReadItemInput[]> {
    const rss = await this.fetchText(this.feedUrl, 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8')
    const items = parseV2exRssItems(rss, this.maxItems)
    const interestedItems: ForumReadItemInput[] = []
    for (const item of items) {
      const enriched = await this.enrichInterestedItem(item)
      if (enriched) interestedItems.push(enriched)
    }
    return interestedItems
  }
}

export async function pollV2exFeed(
  target: V2exFeedTarget,
  options: Omit<V2exConnectorOptions, 'target'> & PollForumConnectorOptions = {},
) {
  const connector = new V2exRssConnector({ ...options, target })
  return pollForumConnector(connector, {
    ...options,
    selectionReason: options.selectionReason ?? `read-only V2EX RSS poll from ${connector.source.externalId}`,
  })
}

export function startV2exForumPolling(options: V2exPollingOptions): NodeJS.Timeout[] {
  if (!options.enabled) return []

  const timers: NodeJS.Timeout[] = []
  const pollTarget = async (target: V2exFeedTarget) => {
    try {
      const connector = new V2exRssConnector({
        target,
        maxItems: options.maxItemsPerFeed,
        timeoutMs: options.timeoutMs,
        userAgent: options.userAgent,
        interestKeywords: options.interestKeywords,
        fetchDetails: options.fetchDetails,
        detailReplyLimit: options.detailReplyLimit,
      })
      const items = await connector.poll()
      const results = await pollForumConnector(new StaticForumFeedConnector(connector.source, items), {
        now: options.now,
        readForumItem: options.readForumItem,
        selectionReason: options.selectionReason ?? `read-only V2EX RSS poll from ${connector.source.externalId}`,
      })
      options.onPoll?.({ target, itemCount: items.length, readCount: results.length })
    } catch (error) {
      options.onError?.(error, target)
    }
  }

  for (const target of options.feeds.length ? options.feeds : [{ type: 'latest' } satisfies V2exFeedTarget]) {
    void pollTarget(target)
    if (options.intervalMs > 0) {
      timers.push(setInterval(() => void pollTarget(target), options.intervalMs))
    }
  }
  return timers
}
