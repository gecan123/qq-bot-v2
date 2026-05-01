import type { AgentMessage } from '../agent/types.js'

/**
 * Phase 1.5: 对话摘要接口。
 *
 * 单 shot 调用, 不参与 reply 主链路, 不影响 KV cache。
 * compaction 触发时调用, 把要压缩的真多轮 history 压成一段文本摘要,
 * 该摘要会写进 conversation_state.compactedBase, 下次 buildContext 读出来
 * 作为 reply history 的"历史摘要"前缀。
 *
 * 实现层不绑定具体 provider, compaction 通过依赖注入接收 summarizer。
 */
export interface ConversationSummarizer {
  summarize(input: SummarizeInput): Promise<string>
}

export interface SummarizeInput {
  previousSummary: string | null
  historyToCompress: AgentMessage[]
}

export const SUMMARIZER_SYSTEM_PROMPT = `
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

export const SUMMARIZER_TRIGGER_INSTRUCTION = '请把以上历史对话压缩成中文摘要。'

/**
 * 把 summarize input 拼装成喂给 LLM 的 history。
 * 抽出来便于单测 (验证拼装顺序), 也让 OpenAI 实现保持薄。
 */
export function buildSummarizerHistory(input: SummarizeInput): AgentMessage[] {
  const messages: AgentMessage[] = []

  const previous = input.previousSummary?.trim()
  if (previous) {
    messages.push({ role: 'user', content: `[上次摘要]\n${previous}` })
  }

  messages.push(...input.historyToCompress)

  messages.push({ role: 'user', content: SUMMARIZER_TRIGGER_INSTRUCTION })

  return messages
}
