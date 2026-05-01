import type { AgentMessage } from '../agent/types.js'

const TRIGGER_FALLBACK = '（消息文本暂不可用；若确实无法判断，再提一个最小必要澄清问题）'

function normalizeBlock(text: string | null | undefined): string | null {
  const normalized = text?.trim()
  return normalized ? normalized : null
}

export interface BuildReplyHistoryInput {
  windowHistory: AgentMessage[]
  compactedSummary?: string
  trigger: string | null | undefined
}

/**
 * 永续上下文契约:
 * - compactedSummary 之前的所有内容是稳定前缀, 直到下次 compaction
 * - windowHistory 严格按 anchor 顺序, 只取 lastCompactedMessageRowId 之后
 * - trigger 永远是最后一条 user message
 * - 这三段拼起来就是当次 LLM call 的完整 history
 */
export function buildReplyHistory(input: BuildReplyHistoryInput): AgentMessage[] {
  const messages: AgentMessage[] = []

  const summary = normalizeBlock(input.compactedSummary)
  if (summary) {
    messages.push({ role: 'user', content: `[历史摘要]\n${summary}` })
  }

  messages.push(...input.windowHistory)

  const trigger = normalizeBlock(input.trigger)
  messages.push({
    role: 'user',
    content: trigger ? `[当前要回复的消息]\n${trigger}` : `[当前要回复的消息]\n${TRIGGER_FALLBACK}`,
  })

  return messages
}
