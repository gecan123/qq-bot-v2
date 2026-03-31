import { createAgentTools } from '../agent/tools.js'
import { runAgentLoop } from '../agent/loop.js'
import { createOpenAIAgentAdapter } from '../agent/openai-agent-adapter.js'
import { getAgentProfile } from '../config/agent-profiles.js'
import { getLlmProvider } from '../llm/provider.js'
import { log } from '../logger.js'
import type { IncomingMessage } from './pipeline.js'
import { buildContext, extractResolvedTriggerText, extractTriggerText } from './context-builder.js'

async function singleTurnReply(
  msg: IncomingMessage,
  persona: string,
  contextLimit: number,
): Promise<string | null> {
  const llm = getLlmProvider()
  if (!llm?.generateReply) return null

  const context = await buildContext(msg, contextLimit)
  const triggerText = extractTriggerText(msg.segments)
  return llm.generateReply(persona, context, triggerText || '(用户@了你)')
}

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
  const profile = getAgentProfile(msg.groupId)
  const contextLimit = profile.replyContextMessages ?? 20

  let reply = await agentReply(
    msg,
    profile.persona,
    contextLimit,
    profile.agentMaxSteps,
    profile.agentWarningTimeMs ?? profile.agentMaxTimeMs,
    profile.agentMaxAnswerChars,
  )

  if (reply !== null) return reply

  log.warn({ groupId: msg.groupId }, 'agent_loop_fallback_to_single_turn')
  const llm = getLlmProvider()
  if (!llm?.generateReply) {
    log.warn({ groupId: msg.groupId }, '收到@消息但 LLM 未配置，跳过回复')
    return null
  }

  reply = await singleTurnReply(msg, profile.persona, contextLimit)
  return reply
}

