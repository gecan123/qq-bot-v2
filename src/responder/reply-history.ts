import type { AgentMessage } from '../agent/types.js'

function normalizeBlock(text: string | null | undefined): string | null {
  const normalized = text?.trim()
  return normalized ? normalized : null
}

export function buildReplyHistory(contextText: string | null | undefined, incomingText: string | null | undefined): AgentMessage[] {
  const normalizedContext = normalizeBlock(contextText)
  const normalizedIncoming = normalizeBlock(incomingText)

  const contextContent = normalizedContext
    ? `[近期会话背景]\n${normalizedContext}`
    : '[近期会话背景]\n（暂无近期消息记录）'
  const currentMessageContent = normalizedIncoming
    ? `[当前要回复的消息]\n${normalizedIncoming}`
    : '[当前要回复的消息]\n（消息文本暂不可用；若确实无法判断，再提一个最小必要澄清问题）'

  return [
    { role: 'user', content: contextContent },
    { role: 'user', content: currentMessageContent },
  ]
}
