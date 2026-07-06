import { z } from 'zod'
import { tavily } from '@tavily/core'
import type { Tool } from '../tool.js'
import { config } from '../../config/index.js'

const WEB_SEARCH_MAX_RESULTS = 5
const WEB_SEARCH_MAX_OUTPUT_CHARS = 2_000
const WEB_SEARCH_TITLE_MAX_CHARS = 200
const WEB_SEARCH_URL_MAX_CHARS = 600
const WEB_SEARCH_SNIPPET_MAX_CHARS = 600

function truncate(text: string, max: number): { value: string; truncated: boolean } {
  if (text.length <= max) return { value: text, truncated: false }
  return { value: `${text.slice(0, Math.max(0, max - 1))}…`, truncated: true }
}

export interface WebSearchResult {
  title: string
  url: string
  content: string
}

export interface WebSearchDeps {
  search: (query: string, maxResults: number) => Promise<WebSearchResult[]>
}

export function formatWebSearchResults(results: WebSearchResult[]): string {
  let truncated = false
  const bounded = results.map((result) => {
    const title = truncate(result.title, WEB_SEARCH_TITLE_MAX_CHARS)
    const url = truncate(result.url, WEB_SEARCH_URL_MAX_CHARS)
    const snippet = truncate(result.content, WEB_SEARCH_SNIPPET_MAX_CHARS)
    truncated ||= title.truncated || url.truncated || snippet.truncated
    return { title: title.value, url: url.value, snippet: snippet.value }
  })

  const serialize = () => JSON.stringify({
    ok: true,
    source: 'web_search',
    truncated,
    results: bounded,
  })
  while (bounded.length > 0 && serialize().length > WEB_SEARCH_MAX_OUTPUT_CHARS) {
    bounded.pop()
    truncated = true
  }
  return serialize()
}

export function createWebSearchTool(deps: WebSearchDeps): Tool<{ query: string; maxResults?: number }> {
  return {
    name: 'web_search',
    description: '搜索互联网获取实时信息。当会话历史中找不到答案时使用。',
    schema: z.object({
      query: z.string().min(1).describe('搜索查询词'),
      maxResults: z.number().int().min(1).max(10).optional().describe('结果条数,默认 5,最大 10'),
    }),
    async execute(args) {
      try {
        const results = await deps.search(args.query, Math.min(args.maxResults ?? WEB_SEARCH_MAX_RESULTS, 10))
        return {
          content: formatWebSearchResults(results),
          outcome: { ok: true, code: 'completed' },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const error = `搜索失败: ${message}`
        return {
          content: JSON.stringify({ ok: false, source: 'web_search', code: 'search_failed', error }),
          outcome: { ok: false, code: 'search_failed', error },
        }
      }
    },
  }
}

/**
 * Web search tool. 仅当 TAVILY_API_KEY 已配置时返回非 null。
 */
export function maybeCreateWebSearchTool(): Tool<{ query: string; maxResults?: number }> | null {
  const apiKey = config.tavily?.apiKey
  if (!apiKey) return null
  const client = tavily({ apiKey })
  return createWebSearchTool({
    async search(query, maxResults) {
      const response = await client.search(query, { maxResults })
      return response.results
    },
  })
}
