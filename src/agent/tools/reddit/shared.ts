/**
 * reddit/ 工具公共依赖：UA / fetch / Atom XML 解析帮手 / clip。
 *
 * list_reddit + get_reddit_post 都走 reddit 公开 RSS (Atom feed),
 * 不需要 OAuth, 也不走 .json 端点 (被 reddit 按 IP/network policy 拦)。
 */

import { XMLParser } from 'fast-xml-parser'

export const DEFAULT_USER_AGENT = 'qq-bot-v2/0.1 (+https://github.com/anonymous; idle-fetch MVP)'

export interface RedditFetchDeps {
  fetcher?: typeof fetch
  appender?: (path: string, line: string) => Promise<void>
  timeoutMs?: number
  logPath?: string
  userAgent?: string
  now?: () => Date
}

export interface RedditFetchOutcome {
  status: number
  bytes: number
  body: string
  errorKind?: string
}

/** 拉一段 reddit RSS. AbortController 超时 + 网络错归一为 errorKind, 不抛。 */
export async function fetchRedditRss(
  url: string,
  options: { fetcher: typeof fetch; userAgent: string; timeoutMs: number },
): Promise<RedditFetchOutcome> {
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

// ── Atom XML 解析帮手 ──────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
})

const DIRECT_IMAGE_HOSTS = new Set(['i.redd.it', 'i.imgur.com'])
const IMAGE_EXT_REGEX = /\.(?:jpe?g|png|gif|webp)(?:[?#].*)?$/i

/** 解析 Atom XML 到原始 JS 对象。 */
export function parseAtomXml(xml: string): unknown {
  return xmlParser.parse(xml)
}

/** 把 feed.entry (可能是单个 object 或 array) 规范化成 array。 */
export function normalizeEntries(rawEntries: unknown): Record<string, unknown>[] {
  if (!rawEntries) return []
  const list = Array.isArray(rawEntries) ? rawEntries : [rawEntries]
  return list.filter((e): e is Record<string, unknown> => e != null && typeof e === 'object')
}

export function pickText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj['#text'] === 'string') return obj['#text']
  }
  return ''
}

export function pickLinkHref(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  const candidates = Array.isArray(value) ? value : [value]
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      const href = (c as Record<string, unknown>)['@_href']
      if (typeof href === 'string' && href.length > 0) return href
    }
  }
  return ''
}

export function pickUrlAttr(value: unknown): string {
  if (!value) return ''
  const candidates = Array.isArray(value) ? value : [value]
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      const url = (c as Record<string, unknown>)['@_url']
      if (typeof url === 'string' && url.length > 0) return decodeHtmlEntities(url)
    }
  }
  return ''
}

export function pickAuthorName(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  return pickText((value as Record<string, unknown>).name)
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
}

export function stripHtml(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeImageUrl(raw: string): string {
  const decoded = decodeHtmlEntities(raw).replace(/&amp;/g, '&')
  try {
    const url = new URL(decoded)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return url.toString()
  } catch {
    return ''
  }
}

function rankImageUrl(value: string): number {
  try {
    const url = new URL(value)
    if (DIRECT_IMAGE_HOSTS.has(url.hostname) && IMAGE_EXT_REGEX.test(url.pathname)) return 0
    if (IMAGE_EXT_REGEX.test(url.pathname)) return 1
    return 2
  } catch {
    return 3
  }
}

export function extractImageUrlFromHtml(html: string, fallbackUrl = ''): string {
  const decoded = decodeHtmlEntities(html)
  const candidates = new Map<string, string>()
  const urlRegex = /https?:\/\/[^\s"'<>]+/g

  for (const match of decoded.matchAll(urlRegex)) {
    const normalized = normalizeImageUrl(match[0] ?? '')
    if (!normalized) continue
    try {
      const parsed = new URL(normalized)
      if (!IMAGE_EXT_REGEX.test(parsed.pathname)) continue
      candidates.set(normalized, normalized)
    } catch {
      // ignored: normalizeImageUrl already filters malformed URLs.
    }
  }

  const fallback = normalizeImageUrl(fallbackUrl)
  if (fallback) candidates.set(fallback, fallback)

  return [...candidates.values()].sort((a, b) => rankImageUrl(a) - rankImageUrl(b))[0] ?? ''
}

/** 字符级硬截断, 超出时尾部补 …。 */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max).trimEnd() + '…'
}

/** 折叠所有空白成单空格。 */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
