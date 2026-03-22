import type { IncomingMessage } from './pipeline.js'
import type { ParsedSegment, ReplySegment } from '../types/message-segments.js'
import { getRecentGroupMessages, getMessageById } from '../database/messages.js'
import { resolveMessage } from '../media/message-resolver.js'
import { ensureDescriptions } from './ensure-descriptions.js'
import { config } from '../config/index.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { getMessageTimestamp } from '../utils/message-time.js'

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export async function buildContext(msg: IncomingMessage, contextLimit: number): Promise<string> {
  const lines: string[] = []

  const replySegment = msg.segments.find((s): s is ReplySegment => s.type === 'reply')
  if (replySegment) {
    const replyMsgId = Number(replySegment.messageId)
    const quotedMsg = await getMessageById(msg.groupId, replyMsgId)
    if (quotedMsg) {
      const resolvedSegments = await resolveMessage(quotedMsg)
      const nickname = quotedMsg.senderGroupNickname ?? quotedMsg.senderNickname
      const text = segmentsToPlainText(resolvedSegments)
      lines.push(`[被引用消息] ${nickname}: ${text}`)
      lines.push('')
    }
  }

  const recentMessages = await getRecentGroupMessages(msg.groupId, contextLimit)

  // 等待最近 N 条消息的媒体描述生成完毕（超时后降级为占位符）
  const waitMessages = recentMessages.slice(-config.replyMediaWaitN)
  await ensureDescriptions(waitMessages, config.replyMediaTimeoutMs)

  for (const dbMsg of recentMessages) {
    const resolvedSegments = await resolveMessage(dbMsg)
    const nickname = dbMsg.senderGroupNickname ?? dbMsg.senderNickname
    const time = formatTime(getMessageTimestamp(dbMsg))
    const text = segmentsToPlainText(resolvedSegments)
    if (text) lines.push(`[${time}] ${nickname}: ${text}`)
  }

  return lines.join('\n')
}

export function extractTriggerText(segments: ParsedSegment[]): string {
  return segmentsToPlainText(segments.filter((s) => s.type !== 'reply'))
}

/**
 * 从数据库中解析当前消息并提取 trigger 文本，包含图片描述等媒体信息。
 * 在 buildContext 之后调用，此时 ensureDescriptions 已完成。
 */
export async function extractResolvedTriggerText(
  groupId: number,
  messageId: number,
  fallbackSegments: ParsedSegment[],
): Promise<string> {
  const dbMsg = await getMessageById(groupId, messageId)
  const segments = dbMsg ? await resolveMessage(dbMsg) : fallbackSegments
  return extractTriggerText(segments)
}
