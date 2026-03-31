import type { Handler } from '../pipeline.js'
import type { AtSegment } from '../../types/message-segments.js'
import { config } from '../../config/index.js'
import { messageSender } from '../../messaging/message-sender.js'
import { log } from '../../logger.js'
import { generateMentionReply } from '../reply-generator.js'

export const atMentionHandler: Handler = async (msg) => {
  const isMentioned = msg.segments.some(
    (s): s is AtSegment => s.type === 'at' && s.targetId === String(config.selfNumber),
  )
  if (!isMentioned) return 'continue'

  try {
    const reply = await generateMentionReply(msg)
    if (reply === null) {
      log.error({ groupId: msg.groupId }, '@回复生成失败，跳过')
      return 'break'
    }

    await messageSender.replyToMessage({
      groupId: msg.groupId,
      replyToMessageId: msg.messageId,
      mentionUserId: msg.senderId,
      text: reply,
    })
  } catch (error) {
    log.error({ error, groupId: msg.groupId, messageId: msg.messageId }, '@回复处理失败')
  }

  return 'break'
}
