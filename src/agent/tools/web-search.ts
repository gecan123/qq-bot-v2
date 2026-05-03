import { z } from 'zod'
import { tavily } from '@tavily/core'
import type { Tool } from '../tool.js'
import { config } from '../../config/index.js'

const WEB_SEARCH_MAX_RESULTS = 5
const WEB_SEARCH_MAX_OUTPUT_CHARS = 2_000

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function formatResults(results: Array<{ title: string; url: string; content: string }>): string {
  const payload = {
    results: results.map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
  }
  return truncate(JSON.stringify(payload, null, 2), WEB_SEARCH_MAX_OUTPUT_CHARS)
}

/**
 * Web search tool. 仅当 TAVILY_API_KEY 已配置时返回非 null。
 */
export function maybeCreateWebSearchTool(): Tool<{ query: string; maxResults?: number }> | null {
  const apiKey = config.tavily?.apiKey
  if (!apiKey) return null

  return {
    name: 'web_search',
    description: '搜索互联网获取实时信息。当会话历史中找不到答案时使用。',
    schema: z.object({
      query: z.string().min(1).describe('搜索查询词'),
      maxResults: z.number().int().min(1).max(10).optional().describe('结果条数,默认 5,最大 10'),
    }),
    async execute(args) {
      try {
        const client = tavily({ apiKey })
        const response = await client.search(args.query, {
          maxResults: Math.min(args.maxResults ?? WEB_SEARCH_MAX_RESULTS, 10),
        })
        return { content: formatResults(response.results) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: JSON.stringify({ error: `搜索失败: ${message}` }) }
      }
    },
  }
}
