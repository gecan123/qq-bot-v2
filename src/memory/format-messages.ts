import type { Message } from '../generated/prisma/client.js'
import type { ParsedSegment } from '../types/message-segments.js'

function segmentsToText(segments: ParsedSegment[]): string {
  return segments
    .map((seg) => {
      switch (seg.type) {
        case 'text': return seg.content
        case 'image': return seg.summary ? `[图片: ${seg.summary}]` : '[图片]'
        case 'video': return seg.description ? `[视频: ${seg.description}]` : '[视频]'
        case 'record': return seg.description ? `[语音: ${seg.description}]` : '[语音]'
        case 'file': return seg.fileName ? `[文件: ${seg.fileName}]` : '[文件]'
        case 'at': return seg.targetName ? `@${seg.targetName}` : `@${seg.targetId}`
        default: return ''
      }
    })
    .join('')
    .trim()
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function formatMessagesForMemory(messages: Message[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    const segments = msg.content as unknown as ParsedSegment[]
    const text = segmentsToText(segments)
    if (!text) continue
    const nickname = msg.senderGroupNickname ?? msg.senderNickname
    const time = formatTime(msg.createdAt)
    lines.push(`[${time}] ${nickname}: ${text}`)
  }
  return lines.join('\n')
}
