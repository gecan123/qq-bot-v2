import type { Handler } from '../pipeline.js'
import type { AtSegment } from '../../types/message-segments.js'
import { config } from '../../config/index.js'
import { getAgentProfile } from '../../config/agent-profiles.js'
import { getLlmProvider } from '../../llm/provider.js'
import { buildContext, extractTriggerText } from '../context-builder.js'
import { sendGroupReply } from '../reply-executor.js'
import { log } from '../../logger.js'

export const atMentionHandler: Handler = async (msg) => {
  const isMentioned = msg.segments.some(
    (s): s is AtSegment => s.type === 'at' && s.targetId === String(config.selfNumber)
  )
  if (!isMentioned) return 'continue'

  const llm = getLlmProvider()
  if (!llm?.generateReply) {
    log.warn({ groupId: msg.groupId }, '收到@消息但 LLM 未配置，跳过回复')
    return 'break'
  }

  const profile = getAgentProfile(msg.groupId)
  const contextLimit = profile.replyContextMessages ?? 30

  try {
    const context = await buildContext(msg, contextLimit)
    const triggerText = extractTriggerText(msg.segments)

    const reply = await llm.generateReply(profile.persona, context, triggerText || '(用户@了你)')

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
