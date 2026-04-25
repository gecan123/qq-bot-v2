import { createLogger } from '../logger.js'
import type { TokenUsageSummary } from '../llm/token-usage.js'

const log = createLogger('REPLY')

export function logMentionReplyTokenUsage(params: {
  groupId: number
  messageId: number
  mode: 'agent' | 'single_turn'
  durationMs: number
  summary: TokenUsageSummary
}): void {
  log.info(
    {
      direction: 'internal',
      actor: 'bot',
      category: 'mention_reply',
      flow: 'reply_generation_token_usage',
      groupId: params.groupId,
      messageId: params.messageId,
      mode: params.mode,
      durationMs: params.durationMs,
      promptTokens: params.summary.total.promptTokens,
      completionTokens: params.summary.total.completionTokens,
      totalTokens: params.summary.total.totalTokens,
      llmCalls: params.summary.total.calls,
      byOperation: params.summary.byOperation,
    },
    'at_mention_token_usage',
  )
}
