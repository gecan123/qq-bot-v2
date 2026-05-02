import { agentClient, agentModel } from '../agent/runtime.js'
import { toOpenAIMessages } from '../agent/openai-compat.js'
import { recordCurrentTokenUsage, toTokenUsage } from '../llm/token-usage.js'
import { createLogger } from '../logger.js'
import type { AgentContext } from '../agent/agent-context.js'
import type { AgentMessage } from '../agent/types.js'

/**
 * Phase D: compaction 改成在 AgentContext 上 in-place replaceMessages。
 * 阈值改成 token-based, 因为永续上下文真正怕的是 token 烧穿 cache, 不是消息条数。
 *
 * compaction 是计划性破坏 prefix 的"昂贵操作": replaceMessages 会让 prefixHash 变。
 * 频率越低越好, 所以默认阈值定得比较高, 留出长期 append-only 的窗口。
 */

const DEFAULT_COMPACTION_TRIGGER_TOKENS = 12_000
const DEFAULT_COMPACTION_KEEP_RATIO = 0.1

const log = createLogger('COMPACTION')

const SUMMARIZER_SYSTEM_PROMPT = `
你是一个对话摘要助手。接下来会喂给你一段历史对话片段, 由群聊用户消息 (user role) 和你过去发出去的回复 (assistant role) 组成。

你的任务: 把这段对话压缩成简洁的中文摘要, 只保留:
- 已被讨论的话题和结论
- 重要事实、意图、情绪
- 你自己 (assistant 角色) 说过 / 承诺过的事

忽略: 客套、口水、未展开的玩笑、被覆盖的旧话题。

如果给你了 [上次摘要], 把它和新对话合并成新摘要, 不要简单 append。

输出: 仅一段连贯的中文文本, 不要标题不要列表, 控制在 400 字以内。
不要回应或继续对话。直接输出摘要。
`.trim()

const SUMMARIZER_TRIGGER_INSTRUCTION = '请把以上历史对话压缩成中文摘要。'
const SUMMARY_HEAD_PREFIX = '[历史摘要]\n'

export interface SummarizeInput {
  /** 现存 messages 头部如果已经是上次摘要, 抽出来作为合并输入 (system prompt 要求合并不是 append) */
  previousSummary: string | null
  /** 要被压缩的多轮消息片段。已包含媒体冻结后的 user / model / tool_calls / tool_results 形态 */
  history: AgentMessage[]
}

export type SummarizeFn = (input: SummarizeInput) => Promise<string>

export interface MaybeCompactOptions {
  /** 测试可注入。生产默认走内嵌 OpenAI-compatible 调用。 */
  summarize?: SummarizeFn
  /** 触发阈值 (token 估算)。超过则压缩。默认 12k token。 */
  triggerTokens?: number
  /** 保留比例 (0..1)。压缩后保留尾部 max(1, ceil(N * ratio)) 条。默认 0.1。 */
  keepRatio?: number
}

/**
 * 估算 messages 数组的 token 总数。
 * 中文 ~ 2 chars/token, 英文 ~ 4 chars/token。混合内容粗暴用 chars/2.5 估算,
 * 偏保守 (高估), 触发更早, 不会让真实 token 数突破 cache 边界。
 */
function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'model') {
      chars += m.content.length
    } else if (m.role === 'tool_calls') {
      for (const call of m.calls) {
        chars += call.name.length
        chars += JSON.stringify(call.args).length
      }
    } else {
      for (const result of m.results) {
        chars += result.output.length
        if (result.error) chars += result.error.length
      }
    }
  }
  return Math.ceil(chars / 2.5)
}

/**
 * 切割位置:保留尾部 keep 条, 把前面的压缩。
 * 修正:不能切在 tool_calls 和它的 tool_results 之间 — 模型会看到「我说要调工具」
 * 但找不到工具结果, 状态机断裂。如果 cut 点正好落在 tool_calls turn 之后,
 * 把 cut 推到下一个 tool_results turn 之后, 让 (tool_calls, tool_results) 留作完整对。
 */
function findSafeCutIndex(messages: AgentMessage[], keepCount: number): number {
  if (messages.length <= keepCount) return 0
  let cut = messages.length - keepCount
  if (cut <= 0) return 0

  // 如果 cut 之前一条是 tool_calls, 把 cut 往后推到下一个 tool_results 之后
  const before = messages[cut - 1]
  if (before?.role === 'tool_calls') {
    for (let i = cut; i < messages.length; i++) {
      if (messages[i]?.role === 'tool_results') {
        cut = i + 1
        break
      }
    }
  }
  return cut
}

/**
 * 从 messages 数组头部提取 [历史摘要] 头(如果有), 给 summarize 作为 previousSummary 合并输入。
 * 这是约定: replaceMessages 后 messages[0] 是 SUMMARY_HEAD_PREFIX 起头的 user message。
 * 找不到则返回 null + 原数组。
 */
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
  const messages: AgentMessage[] = []
  const previous = input.previousSummary?.trim()
  if (previous) messages.push({ role: 'user', content: `[上次摘要]\n${previous}` })
  messages.push(...input.history)
  messages.push({ role: 'user', content: SUMMARIZER_TRIGGER_INSTRUCTION })

  const response = await agentClient.chat.completions.create({
    model: agentModel,
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

/**
 * 仅当 context 内 messages 估算 token 总量超过阈值时, 用 LLM 把头部压成单条
 * 摘要 user message 替换 (replaceMessages([summary, ...keptTail]))。
 *
 * 不变量 (修改时务必保留):
 *   1. 在 AgentContext 上 in-place 替换, 不再写另一张表的 compactedBase。
 *   2. 已存在的 [历史摘要] 头部抽出来作为合并输入, 而不是简单累加 (system prompt 要求合并)。
 *   3. summarize 返回空白时不修改 context (避免污染前缀)。
 *   4. cut 边界不切开 tool_calls + tool_results 三元组 (LLM 状态机不能断裂)。
 *   5. 调用方需 try/catch wrap, compaction 失败不影响已 sent reply 的语义。
 */
export async function maybeCompactConversation(
  context: AgentContext,
  options: MaybeCompactOptions = {},
): Promise<void> {
  const summarize = options.summarize ?? defaultSummarize
  const triggerTokens = options.triggerTokens ?? DEFAULT_COMPACTION_TRIGGER_TOKENS
  const keepRatio = options.keepRatio ?? DEFAULT_COMPACTION_KEEP_RATIO

  const snapshot = await context.getSnapshot()
  const tokens = estimateTokens(snapshot.messages)
  if (tokens <= triggerTokens) return

  const keepCount = Math.max(1, Math.ceil(snapshot.messages.length * keepRatio))
  const cutIndex = findSafeCutIndex(snapshot.messages, keepCount)
  if (cutIndex <= 0) return // 全部都要保留, 没东西压

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
  await context.replaceMessages([summaryMessage, ...tail])

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
