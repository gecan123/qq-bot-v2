import type { Message } from '../generated/prisma/client.js'
import { resolveMessage } from './message-resolver.js'
import { freezeResolvedTextIfUnset } from '../database/messages.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('MEDIA_READY')

/**
 * 把 Message row 跑到「LLM 可见的最终文本」状态:
 *  1. 等待该消息中所有引用的媒体描述跑完 (有时间预算 REPLY_MEDIA_TIMEOUT_MS)
 *  2. 把 segments 渲染成纯文本(含 [图片: xxx] 的描述)
 *  3. 把渲染好的文本一次性冻结到 messages.resolved_text (字段是 once-frozen)
 *  4. 返回该文本给 ingest 把它塞进 BotEvent.renderedText
 *
 * resolved_text 一旦写入就不再变化,这是「字节稳定」的物理保证。
 */
export async function ensureMessageReadyForAgent(message: Message): Promise<{
  renderedText: string
  fromFrozen: boolean
}> {
  // 已冻结过 (重启回放 / 已经处理过): 直接用旧值
  if (message.resolvedText !== null && message.resolvedText !== '') {
    return { renderedText: message.resolvedText, fromFrozen: true }
  }

  const resolvedSegments = await resolveMessage(message, {
    timeoutMs: config.replyMediaTimeoutMs,
    priority: 'high',
  })
  const text = segmentsToPlainText(resolvedSegments)

  try {
    await freezeResolvedTextIfUnset(message.id, text)
  } catch (err) {
    log.warn({ err, messageId: message.id }, 'freezeResolvedTextIfUnset failed; proceeding anyway')
  }

  return { renderedText: text, fromFrozen: false }
}
