import { z } from 'zod'
import * as cheerio from 'cheerio'
import type { Tool } from '../tool.js'
import type { LlmClient } from '../llm-client.js'
import { config } from '../../config/index.js'
import { logFetch } from '../../ops/fetch-log.js'
import { createLogger } from '../../logger.js'
import { createLlmClient } from '../llm-client.js'

const log = createLogger('TOOL_FETCH_URL')

/** 工具实现层硬截断 (premise 6 in idle-fetch-mvp). */
const RESPONSE_BODY_CAP_BYTES = 256 * 1024
const EXTRACTED_TEXT_CAP_BYTES = 8 * 1024
const OUTPUT_CAP_CHARS = 1500
const FALLBACK_RAW_CAP_CHARS = 1000

const argsSchema = z.object({
  url: z
    .string()
    .url()
    .describe('要抓取的 URL (非 reddit 页面; reddit 帖子请用 reddit action=get_post).'),
  hint: z
    .string()
    .max(200)
    .optional()
    .describe('给摘要 LLM 的侧重提示 (例: "我想知道作者的核心论点". 可省略).'),
})

type Args = z.infer<typeof argsSchema>

export interface FetchUrlDeps {
  fetcher?: typeof fetch
  appender?: (path: string, line: string) => Promise<void>
  timeoutMs?: number
  logPath?: string
  userAgent?: string
  llm?: LlmClient
  now?: () => Date
}

const DEFAULT_USER_AGENT = 'qq-bot-v2/0.1 (+https://github.com/anonymous; idle-fetch MVP)'

interface FetchOutcome {
  status: number
  bytes: number
  contentType: string
  body: string
  errorKind?: string
}

async function fetchBody(
  url: string,
  options: { fetcher: typeof fetch; userAgent: string; timeoutMs: number },
): Promise<FetchOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await options.fetcher(url, {
      headers: { 'user-agent': options.userAgent, accept: 'text/html,*/*;q=0.5' },
      signal: controller.signal,
      redirect: 'follow',
    })
    const contentType = response.headers.get('content-type') ?? ''

    if (!response.body) {
      const fallback = await response.text()
      return {
        status: response.status,
        bytes: Buffer.byteLength(fallback, 'utf8'),
        contentType,
        body: fallback.slice(0, RESPONSE_BODY_CAP_BYTES),
      }
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        chunks.push(value)
        total += value.byteLength
        if (total >= RESPONSE_BODY_CAP_BYTES) {
          await reader.cancel().catch(() => {})
          break
        }
      }
    } finally {
      reader.releaseLock?.()
    }

    const merged = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    const trimmed = merged.byteLength > RESPONSE_BODY_CAP_BYTES
      ? merged.subarray(0, RESPONSE_BODY_CAP_BYTES)
      : merged

    return {
      status: response.status,
      bytes: total,
      contentType,
      body: trimmed.toString('utf8'),
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      status: -1,
      bytes: 0,
      contentType: '',
      body: '',
      errorKind: aborted ? 'timeout' : 'network_error',
    }
  } finally {
    clearTimeout(timer)
  }
}

interface ExtractedContent {
  title: string
  description: string
  text: string
}

/** 从 HTML 抽取 title / meta description / article-or-main 文本. 纯函数。 */
export function extractFromHtml(html: string): ExtractedContent {
  const $ = cheerio.load(html)
  $('script, style, noscript, template').remove()

  const title = ($('title').first().text() ?? '').trim()
  const description = ($('meta[name="description"]').attr('content') ?? '').trim()

  let bodyEl = $('article').first()
  if (bodyEl.length === 0) bodyEl = $('main').first()
  if (bodyEl.length === 0) bodyEl = $('body').first()
  const text = collapseWhitespace(bodyEl.text())

  return { title, description, text }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clampBytes(value: string, capBytes: number): string {
  const buf = Buffer.from(value, 'utf8')
  if (buf.byteLength <= capBytes) return value
  // 截到 capBytes 边界附近, 避免切断 UTF-8 字符
  const slice = buf.subarray(0, capBytes).toString('utf8')
  // 末尾可能 truncated 字符 → toString('utf8') 自动用 replacement char, 切掉
  return slice.replace(/�+$/g, '').trimEnd()
}

function buildSummarizationPrompt(): string {
  return [
    '你是一个网页摘要助手.',
    '把用户提供的网页正文压缩成 ≤500 字的中文摘要.',
    '要求:',
    '- 只摘要事实和核心观点, 不加你自己的评论.',
    '- 不要 "本文讲了" / "作者认为" 这种填充, 直接说内容.',
    '- 如果是 HN/reddit 那种讨论页, 摘要时点出主帖核心 + 评论里最有 signal 的几个观点.',
    '- 输出纯文本, 不要 markdown 标题.',
  ].join('\n')
}

function buildSummarizationUser(args: { title: string; description: string; text: string; hint?: string }): string {
  const lines: string[] = []
  if (args.title) lines.push(`标题: ${args.title}`)
  if (args.description) lines.push(`简介: ${args.description}`)
  if (args.hint) lines.push(`关注点: ${args.hint}`)
  lines.push('正文:')
  lines.push(args.text)
  return lines.join('\n')
}

export function createFetchUrlTool(deps: FetchUrlDeps = {}): Tool<Args> {
  const fetcher = deps.fetcher ?? fetch
  const timeoutMs = deps.timeoutMs ?? config.fetchUrlTimeoutMs
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT
  const now = deps.now ?? (() => new Date())
  const llm = deps.llm ?? createLlmClient()

  return {
    name: 'fetch_url',
    description: [
      `抓取一个 URL 并返回 ≤ ${OUTPUT_CAP_CHARS} 字符的中文摘要 (目标 ≤ 500 中文字).`,
      '返回的不是原文, 是摘要. 如果摘要不够你判断, 没办法让这个工具给你更长 — 要么换工具 / 要么放弃这条.',
      '典型用法: 非 reddit 的外链页面. reddit 帖子请用 reddit action=get_post, 不要走本工具.',
      'hint 参数可选, 用来影响摘要侧重 (例: "我想知道作者的核心论点").',
      '抓不到 / 摘要失败时返回错误标记 + 原文截断, 可以忽略也可以再试一次.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = rawArgs as Args
      const startedAt = Date.now()
      const outcome = await fetchBody(args.url, { fetcher, userAgent, timeoutMs })
      const fetchDurationMs = Date.now() - startedAt

      const baseLog = {
        ts: now().toISOString(),
        source: 'url',
        url: args.url,
        status: outcome.status,
        bytes: outcome.bytes,
        toolCallId: `round-${ctx.roundIndex}`,
        durationMs: fetchDurationMs,
      }

      if (outcome.errorKind) {
        await logFetch(
          { ...baseLog, errorKind: outcome.errorKind },
          { path: deps.logPath, appender: deps.appender },
        )
        log.warn({ url: args.url, errorKind: outcome.errorKind }, 'fetch_url_failed')
        return {
          content: `[fetch_url 失败] ${args.url}: ${outcome.errorKind}.`,
        }
      }

      if (outcome.status < 200 || outcome.status >= 300) {
        await logFetch(
          { ...baseLog, errorKind: `http_${outcome.status}` },
          { path: deps.logPath, appender: deps.appender },
        )
        return {
          content: `[fetch_url HTTP ${outcome.status}] ${args.url}. 抓不到, 别原地重试.`,
        }
      }

      const isHtml = outcome.contentType.includes('html') || /^\s*<!doctype\s+html|^\s*<html/i.test(outcome.body)
      const extracted = isHtml
        ? extractFromHtml(outcome.body)
        : { title: '', description: '', text: collapseWhitespace(outcome.body) }

      const trimmedText = clampBytes(extracted.text, EXTRACTED_TEXT_CAP_BYTES)
      if (trimmedText.length === 0) {
        await logFetch(
          { ...baseLog, errorKind: 'empty_content' },
          { path: deps.logPath, appender: deps.appender },
        )
        return {
          content: `[fetch_url 内容为空] ${args.url}. 可能是 JS 渲染页或 paywall.`,
        }
      }

      const systemPrompt = buildSummarizationPrompt()
      const userMessage = buildSummarizationUser({
        title: extracted.title,
        description: extracted.description,
        text: trimmedText,
        hint: args.hint,
      })

      let summary = ''
      let summarizeFailed = false
      try {
        const completion = await llm.chat({
          systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
          tools: [],
        })
        summary = completion.content.trim()
      } catch (err) {
        summarizeFailed = true
        log.warn({ url: args.url, err }, 'fetch_url_summarize_failed')
      }

      await logFetch(
        summarizeFailed ? { ...baseLog, errorKind: 'summarize_failed' } : baseLog,
        { path: deps.logPath, appender: deps.appender },
      )

      if (summarizeFailed || summary.length === 0) {
        const fallback = trimmedText.slice(0, FALLBACK_RAW_CAP_CHARS)
        const errorTag = summarizeFailed ? '摘要 LLM 失败' : '摘要为空'
        return {
          content: clampOutput(
            `[fetch_url ${errorTag}] ${args.url}\n标题: ${extracted.title || '(未知)'}\n原文截断:\n${fallback}`,
          ),
        }
      }

      const headerLines = [`[fetch_url 摘要] ${args.url}`]
      if (extracted.title) headerLines.push(`标题: ${extracted.title}`)
      const output = `${headerLines.join('\n')}\n\n${summary}`
      return { content: clampOutput(output) }
    },
  }
}

function clampOutput(value: string): string {
  if (value.length <= OUTPUT_CAP_CHARS) return value
  return value.slice(0, OUTPUT_CAP_CHARS - 1).trimEnd() + '…'
}
