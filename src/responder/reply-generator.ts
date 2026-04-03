import { createAgentTools } from '../agent/tools.js'
import { runAgentLoop } from '../agent/loop.js'
import { createOpenAIAgentAdapter } from '../agent/openai-agent-adapter.js'
import { getAgentProfile } from '../config/agent-profiles.js'
import { getCurrentTokenUsageTracker, runWithTokenUsageTracking } from '../llm/token-usage.js'
import { log } from '../logger.js'
import type { IncomingMessage } from './pipeline.js'
import { buildContext, extractResolvedTriggerText } from './context-builder.js'
import { logMentionReplyTokenUsage } from './reply-token-usage.js'

async function agentReply(
  msg: IncomingMessage,
  persona: string,
  contextLimit: number,
  maxSteps?: number,
  warningTimeMs?: number,
  maxAnswerChars?: number,
): Promise<string | null> {
  const context = await buildContext(msg, contextLimit)

  const triggerText = await extractResolvedTriggerText(msg.groupId, msg.messageId, msg.segments)
  const userMessage = triggerText
    ? `${triggerText}\n\n[群聊背景]\n${context}`
    : `(用户@了你)\n\n[群聊背景]\n${context}`

  const { declarations, executors } = createAgentTools(msg.groupId)
  const adapter = createOpenAIAgentAdapter()
  const now = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const systemPrompt = `当前时间：${now}\n\n${persona}`

  const result = await runAgentLoop({
    systemPrompt,
    userMessage,
    adapter,
    tools: declarations,
    executors,
    maxSteps,
    warningTimeMs,
    maxAnswerChars,
  })

  log.info(
    { groupId: msg.groupId, state: result.state, reason: 'reason' in result ? result.reason : undefined },
    'at_mention_agent_result',
  )

  if (result.state === 'final') return result.answer
  return null
}

export async function generateMentionReply(msg: IncomingMessage): Promise<string | null> {
  return runWithTokenUsageTracking(async () => {
    const startedAt = Date.now()
    const mode: 'agent' = 'agent'

    try {
      const profile = getAgentProfile(msg.groupId)
      const contextLimit = profile.replyContextMessages ?? 20

      const reply = await agentReply(
        msg,
        profile.persona,
        contextLimit,
        profile.agentMaxSteps,
        profile.agentWarningTimeMs ?? profile.agentMaxTimeMs,
        profile.agentMaxAnswerChars,
      )
      return reply
    } finally {
      const summary = getCurrentTokenUsageTracker()?.snapshot()
      if (summary) {
        logMentionReplyTokenUsage({
          groupId: msg.groupId,
          messageId: msg.messageId,
          mode,
          durationMs: Date.now() - startedAt,
          summary,
        })
      }
    }
  })
}
