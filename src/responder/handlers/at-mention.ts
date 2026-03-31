import type { Handler } from '../pipeline.js'
import type { AtSegment } from '../../types/message-segments.js'
import { config } from '../../config/index.js'
import { log } from '../../logger.js'

export const atMentionHandler: Handler = async (msg) => {
  const isMentioned = msg.segments.some(
    (s): s is AtSegment => s.type === 'at' && s.targetId === String(config.selfNumber),
  )
  if (!isMentioned) return 'continue'

  log.debug({ groupId: msg.groupId, messageId: msg.messageId }, '@回复已迁移到异步会话调度器')
  return 'break'
}
