import type { Handler } from '../pipeline.js'
import type { AtSegment } from '../../types/message-segments.js'
import { config } from '../../config/index.js'
import { getAgentProfile } from '../../config/agent-profiles.js'
import { getLlmProvider } from '../../llm/provider.js'
import { buildContext, extractTriggerText } from '../context-builder.js'
import { sendGroupReply } from '../reply-executor.js'
import { shouldUseAgent } from '../../agent/heuristic.js'
import { createAgentTools } from '../../agent/tools.js'
import { runAgentLoop } from '../../agent/loop.js'
import { createOpenAIAgentAdapter } from '../../agent/openai-agent-adapter.js'
import { log } from '../../logger.js'

async function singleTurnReply(
  msg: Parameters<Handler>[0],
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
  msg: Parameters<Handler>[0],
  persona: string,
  contextLimit: number,
  triggerText: string,
): Promise<string | null> {
  const context = await buildContext(msg, contextLimit)

  const userMessage = triggerText
    ? `${triggerText}\n\n[群聊背景]\n${context}`
    : `(用户@了你)\n\n[群聊背景]\n${context}`

  const { declarations, executors } = createAgentTools(msg.groupId)
  const adapter = createOpenAIAgentAdapter()

  const result = await runAgentLoop({
    systemPrompt: persona,
    userMessage,
    adapter,
    tools: declarations,
    executors,
  })

  log.info(
    { groupId: msg.groupId, state: result.state, reason: 'reason' in result ? result.reason : undefined },
    'at_mention_agent_result',
  )

  if (result.state === 'final') return result.answer
  return null
}

export const atMentionHandler: Handler = async (msg) => {
  const isMentioned = msg.segments.some(
    (s): s is AtSegment => s.type === 'at' && s.targetId === String(config.selfNumber),
  )
  if (!isMentioned) return 'continue'

  const profile = getAgentProfile(msg.groupId)
  const contextLimit = profile.replyContextMessages ?? 30
  const agentMode = profile.agentMode ?? 'single'
  const triggerText = extractTriggerText(msg.segments)

  let reply: string | null = null

  try {
    const useAgent =
      agentMode === 'always' || (agentMode === 'heuristic' && shouldUseAgent(triggerText))

    if (useAgent) {
      reply = await agentReply(msg, profile.persona, contextLimit, triggerText)
      if (reply === null) {
        log.warn({ groupId: msg.groupId, agentMode }, 'agent_loop_fallback_to_single_turn')
      }
    }

    if (reply === null) {
      const llm = getLlmProvider()
      if (!llm?.generateReply) {
        log.warn({ groupId: msg.groupId }, '收到@消息但 LLM 未配置，跳过回复')
        return 'break'
      }
      reply = await singleTurnReply(msg, profile.persona, contextLimit)
    }

    if (reply === null) {
      log.error({ groupId: msg.groupId }, '@回复生成失败，跳过')
      return 'break'
    }

    await sendGroupReply(msg.groupId, [
      { type: 'reply', data: { id: msg.messageId } },
      { type: 'at', data: { qq: String(msg.senderId) } },
      { type: 'text', data: { text: ' ' + reply } },
    ])
  } catch (error) {
    log.error({ error, groupId: msg.groupId, messageId: msg.messageId }, '@回复处理失败')
  }

  return 'break'
}
