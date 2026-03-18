import { z } from 'zod'
import { tavily } from '@tavily/core'
import type { AgentToolDeclaration } from './types.js'
import { searchMessages, getUserProfile, getGroupSummary } from '../database/search.js'
import { getRecentGroupMessages } from '../database/messages.js'
import { config } from '../config/index.js'

export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>

const MAX_INFO_CHARS = 2000
const MAX_PROFILE_CHARS = 1000
const MAX_ANSWER_CHARS = 500

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function formatSearchResults(results: Awaited<ReturnType<typeof searchMessages>>): string {
  if (results.length === 0) return '（无匹配结果）'
  return results.map((r) => `[${r.time}] ${r.senderName}: ${r.text}`).join('\n')
}

const searchMessagesDecl: AgentToolDeclaration = {
  name: 'search_messages',
  description: '在群消息历史中搜索包含指定关键词的消息',
  inputSchema: z.object({
    keyword: z.string().describe('搜索关键词'),
    limit: z.number().int().min(1).max(20).default(10).describe('返回结果数量，最多20条'),
  }),
}

const getRecentMessagesDecl: AgentToolDeclaration = {
  name: 'get_recent_messages',
  description: '获取群内最近的消息记录，可指定截止消息ID以获取更早的消息',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(30).default(10).describe('返回消息条数，最多30条'),
    beforeMessageId: z.number().int().optional().describe('返回此消息ID之前的消息，用于翻页'),
  }),
}

const getUserProfileDecl: AgentToolDeclaration = {
  name: 'get_user_profile',
  description: '获取群内某个用户的画像信息（性格、习惯、历史发言特点等）',
  inputSchema: z.object({
    senderId: z.number().int().describe('目标用户的QQ号'),
  }),
}

const getGroupSummaryDecl: AgentToolDeclaration = {
  name: 'get_group_summary',
  description: '获取本群的整体摘要，包括近期主要话题和群氛围',
  inputSchema: z.object({}),
}

const finalAnswerDecl: AgentToolDeclaration = {
  name: 'final_answer',
  description: '当你已经收集到足够信息，准备好最终回复时调用此工具。调用后循环立即终止。',
  inputSchema: z.object({
    text: z.string().describe('发送给用户的最终回复内容，不超过500字'),
  }),
}

const webSearchDecl: AgentToolDeclaration = {
  name: 'web_search',
  description:
    '搜索互联网获取实时信息。当群聊历史中找不到答案，或问题涉及最新新闻、实时数据、外部知识时使用。',
  inputSchema: z.object({
    query: z.string().describe('搜索查询词，用中文或英文均可'),
  }),
}

export interface AgentTools {
  declarations: AgentToolDeclaration[]
  executors: Record<string, ToolExecutor>
}

const MAX_WEB_SEARCH_CHARS = 2000

function formatWebSearchResults(
  results: Array<{ title: string; url: string; content: string }>,
): string {
  if (results.length === 0) return '（无搜索结果）'
  const formatted = results.map((r) => `[${r.title}](${r.url})\n${r.content}`).join('\n\n')
  return formatted.length > MAX_WEB_SEARCH_CHARS
    ? formatted.slice(0, MAX_WEB_SEARCH_CHARS) + '…'
    : formatted
}

export function createAgentTools(groupId: number): AgentTools {
  const declarations: AgentToolDeclaration[] = [
    searchMessagesDecl,
    getRecentMessagesDecl,
    getUserProfileDecl,
    getGroupSummaryDecl,
    finalAnswerDecl,
  ]

  if (config.tavily?.apiKey) {
    declarations.push(webSearchDecl)
  }

  const executors: Record<string, ToolExecutor> = {
    search_messages: async (args) => {
      const parsed = searchMessagesDecl.inputSchema.parse(args) as { keyword: string; limit: number }
      const results = await searchMessages(groupId, parsed.keyword, parsed.limit)
      return truncate(formatSearchResults(results), MAX_INFO_CHARS)
    },

    get_recent_messages: async (args) => {
      const parsed = getRecentMessagesDecl.inputSchema.parse(args) as {
        limit: number
        beforeMessageId?: number
      }
      const messages = await getRecentGroupMessages(groupId, parsed.limit, parsed.beforeMessageId)
      if (messages.length === 0) return '（无消息记录）'
      const lines = messages.map((m) => {
        const name = m.senderGroupNickname ?? m.senderNickname ?? String(m.senderId)
        const time = m.createdAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
        const text = m.searchText || '（媒体消息）'
        return `[${time}] ${name}: ${text}`
      })
      return truncate(lines.join('\n'), MAX_INFO_CHARS)
    },

    get_user_profile: async (args) => {
      const parsed = getUserProfileDecl.inputSchema.parse(args) as { senderId: number }
      const profile = await getUserProfile(groupId, parsed.senderId)
      if (!profile) return '（该用户暂无画像信息）'
      const lines = [
        `昵称: ${profile.senderGroupNickname ?? profile.senderNickname ?? String(profile.senderId)}`,
        `画像: ${profile.profile}`,
      ]
      if (profile.examples.length > 0) {
        lines.push(`典型发言: ${profile.examples.slice(0, 3).join(' / ')}`)
      }
      return truncate(lines.join('\n'), MAX_PROFILE_CHARS)
    },

    get_group_summary: async (_args) => {
      const summary = await getGroupSummary(groupId)
      if (!summary) return '（暂无群摘要）'
      return truncate(summary.summary, MAX_PROFILE_CHARS)
    },

    final_answer: async (args) => {
      const parsed = finalAnswerDecl.inputSchema.parse(args) as { text: string }
      return parsed.text.slice(0, MAX_ANSWER_CHARS)
    },

    web_search: async (args) => {
      const parsed = webSearchDecl.inputSchema.parse(args) as { query: string }
      const apiKey = config.tavily?.apiKey
      if (!apiKey) return '（web_search 工具未配置 API key）'
      try {
        const client = tavily({ apiKey })
        const response = await client.search(parsed.query, { maxResults: 5 })
        return formatWebSearchResults(response.results)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return `搜索失败: ${message}`
      }
    },
  }

  return { declarations, executors }
}
