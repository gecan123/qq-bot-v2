import type { IncomingMessage } from './pipeline.js'
import type { ParsedSegment, ReplySegment } from '../types/message-segments.js'
import { getRecentGroupMessages, getMessageById } from '../database/messages.js'
import { resolveMessage } from '../media/message-resolver.js'
import { ensureDescriptions } from './ensure-descriptions.js'
import { config } from '../config/index.js'

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function segmentsToText(segments: ParsedSegment[]): string {
  return segments
    .map((seg) => {
      switch (seg.type) {
        case 'text':
          return seg.content
        case 'image':
          return seg.summary ? `[图片: ${seg.summary}]` : '[图片]'
        case 'video':
          return seg.description ? `[视频: ${seg.description}]` : '[视频]'
        case 'record':
          return seg.description ? `[语音: ${seg.description}]` : '[语音]'
        case 'file':
          return seg.fileName ? `[文件: ${seg.fileName}]` : '[文件]'
        case 'face':
          return seg.name ? `[表情: ${seg.name}]` : '[表情]'
        case 'at':
          return seg.targetName ? `@${seg.targetName}` : `@${seg.targetId}`
        case 'reply':
          return ''
        case 'raw':
          return `[${seg.originalType}]`
        default:
          return ''
      }
    })
    .join('')
    .trim()
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
      const text = segmentsToText(resolvedSegments)
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
    const time = formatTime(dbMsg.createdAt)
    const text = segmentsToText(resolvedSegments)
    if (text) lines.push(`[${time}] ${nickname}: ${text}`)
  }

  return lines.join('\n')
}

export function extractTriggerText(segments: ParsedSegment[]): string {
  return segments
    .filter((s) => s.type === 'text')
    .map((s) => (s.type === 'text' ? s.content : ''))
    .join(' ')
    .trim()
}
