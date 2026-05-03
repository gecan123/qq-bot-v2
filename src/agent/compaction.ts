import OpenAI from 'openai'
import type { AgentContext } from './agent-context.js'
import type { AgentMessage } from './agent-context.types.js'
import { toOpenAIMessages } from './llm-client.js'
import { config } from '../config/index.js'
import { recordCurrentTokenUsage, toTokenUsage } from '../llm/token-usage.js'
import { createLogger } from '../logger.js'

/**
 * Compaction 是「计划性破坏 prefix」的唯一路径 (CLAUDE.md 红线 4)。
 * 别处不允许调 replaceMessages。
 *
 * 触发: 估算 token 总数 > triggerTokens, 默认 12k。
 * 保留: 尾部 keepRatio (默认 0.1) 条, 但不切开 assistant.toolCalls 和它的 tool result。
 * 输出: replaceMessages([summaryHead, ...keptTail]), 头部一条 user message
 *      "[历史摘要] ..." 包住摘要文本。
 */
const DEFAULT_COMPACTION_TRIGGER_TOKENS = 12_000
const DEFAULT_COMPACTION_KEEP_RATIO = 0.1
const SUMMARY_HEAD_PREFIX = '[历史摘要]\n'

const log = createLogger('COMPACTION')

const SUMMARIZER_SYSTEM_PROMPT = `
你是一个对话摘要助手。接下来会喂给你一段历史聊天片段, 由群聊用户消息 (user role)、
你过去的回复或想法 (assistant role)、以及工具调用结果 (tool role) 组成。

你的任务: 把这段对话压缩成简洁的中文摘要, 只保留:
  - 已被讨论的话题和结论
  - 重要事实、群成员的偏好或情绪
  - 你自己 (assistant 角色) 说过 / 承诺过的事
  - 关键工具查询结果

忽略: 客套、口水、未展开的玩笑、被覆盖的旧话题。

如果给你了 [上次摘要], 把它和新对话合并成新摘要, 不要简单 append。

输出: 仅一段连贯的中文文本, 不要标题不要列表, 控制在 400 字以内。
不要回应或继续对话。直接输出摘要。
`.trim()

const SUMMARIZER_TRIGGER_INSTRUCTION = '请把以上历史对话压缩成中文摘要。'

export interface SummarizeInput {
  previousSummary: string | null
  history: AgentMessage[]
}

export type SummarizeFn = (input: SummarizeInput) => Promise<string>

export interface MaybeCompactOptions {
  summarize?: SummarizeFn
  triggerTokens?: number
  keepRatio?: number
}

/**
 * 估算 messages 数组的 token 总数。
 * 中英混合用 chars/2.5 估算, 偏保守 (高估), 触发更早, 不会让真实 token 数突破 cache 边界。
 */
function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (m.role === 'user') {
      chars += m.content.length
    } else if (m.role === 'assistant') {
      chars += m.content.length
      for (const call of m.toolCalls) {
        chars += call.name.length + JSON.stringify(call.args).length
      }
    } else {
      chars += m.content.length
    }
  }
  return Math.ceil(chars / 2.5)
}

/**
 * 切割位置: 保留尾部 keep 条, 把前面的压缩。
 * 修正: 不能切在 assistant(toolCalls) 和它对应的 tool result 之间。
 * 如果 cut 之前一条是 assistant + toolCalls, 把 cut 推到对应 tool result 之后。
 */
function findSafeCutIndex(messages: AgentMessage[], keepCount: number): number {
  if (messages.length <= keepCount) return 0
  let cut = messages.length - keepCount
  if (cut <= 0) return 0

  const before = messages[cut - 1]
  if (before?.role === 'assistant' && before.toolCalls.length > 0) {
    const expectedToolCallIds = new Set(before.toolCalls.map((c) => c.id))
    let i = cut
    while (i < messages.length) {
      const m = messages[i]
      if (m && m.role === 'tool' && expectedToolCallIds.has(m.toolCallId)) {
        expectedToolCallIds.delete(m.toolCallId)
        i++
        if (expectedToolCallIds.size === 0) {
          cut = i
          break
        }
      } else {
        i++
      }
    }
  }
  return cut
}

function splitExistingSummary(messages: AgentMessage[]): {
  previousSummary: string | null
  rest: AgentMessage[]
} {
  const head = messages[0]
  if (head?.role !== 'user' || !head.content.startsWith(SUMMARY_HEAD_PREFIX)) {
    return { previousSummary: null, rest: messages }
  }
  return {
    previousSummary: head.content.slice(SUMMARY_HEAD_PREFIX.length).trim(),
    rest: messages.slice(1),
  }
}

async function defaultSummarize(input: SummarizeInput): Promise<string> {
  const provider = config.llm.providers[config.llm.defaultProvider]
  const client = new OpenAI({ baseURL: provider.url, apiKey: provider.apiKey })

  const messages: AgentMessage[] = []
  const previous = input.previousSummary?.trim()
  if (previous) {
    messages.push({ role: 'user', content: `[上次摘要]\n${previous}` })
  }
  messages.push(...input.history)
  messages.push({ role: 'user', content: SUMMARIZER_TRIGGER_INSTRUCTION })

  const response = await client.chat.completions.create({
    model: config.llm.defaultModel,
    temperature: 0.3,
    messages: toOpenAIMessages(SUMMARIZER_SYSTEM_PROMPT, messages),
  })
  recordCurrentTokenUsage('compaction.summarize', toTokenUsage(response.usage))

  const content = response.choices[0]?.message?.content
  if (typeof content !== 'string') {
    log.warn({ choices: response.choices.length }, 'summarizer_empty_response')
    return ''
  }
  return content.trim()
}

export async function maybeCompactConversation(
  context: AgentContext,
  options: MaybeCompactOptions = {},
): Promise<void> {
  const summarize = options.summarize ?? defaultSummarize
  const triggerTokens = options.triggerTokens ?? DEFAULT_COMPACTION_TRIGGER_TOKENS
  const keepRatio = options.keepRatio ?? DEFAULT_COMPACTION_KEEP_RATIO

  const snapshot = context.getSnapshot()
  const tokens = estimateTokens(snapshot.messages)
  if (tokens <= triggerTokens) return

  const keepCount = Math.max(1, Math.ceil(snapshot.messages.length * keepRatio))
  const cutIndex = findSafeCutIndex(snapshot.messages, keepCount)
  if (cutIndex <= 0) return

  const toCompress = snapshot.messages.slice(0, cutIndex)
  const tail = snapshot.messages.slice(cutIndex)
  const { previousSummary, rest: historyToSummarize } = splitExistingSummary(toCompress)

  if (historyToSummarize.length === 0 && !previousSummary) {
    return
  }

  const newSummary = await summarize({
    previousSummary,
    history: historyToSummarize,
  })
  if (!newSummary.trim()) {
    log.warn({ tokens, cutIndex, tailLen: tail.length }, 'compaction_skipped_empty_summary')
    return
  }

  const summaryMessage: AgentMessage = {
    role: 'user',
    content: `${SUMMARY_HEAD_PREFIX}${newSummary.trim()}`,
  }
  context.replaceMessages([summaryMessage, ...tail])

  log.info(
    {
      previousMessages: snapshot.messages.length,
      newMessages: 1 + tail.length,
      compressedCount: toCompress.length,
      keptCount: tail.length,
      estimatedTokens: tokens,
    },
    'compaction_replaced',
  )
}
