import type { Message } from '../generated/prisma/client.js'
import type { ParsedSegment } from '../types/message-segments.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { getMessageTimestamp } from '../utils/message-time.js'

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function formatMessagesForMemory(messages: Message[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    const segments = msg.content as unknown as ParsedSegment[]
    const text = segmentsToPlainText(segments)
    if (!text) continue
    const nickname = msg.senderGroupNickname ?? msg.senderNickname
    const time = formatTime(getMessageTimestamp(msg))
    lines.push(`[${time}] ${nickname}: ${text}`)
  }
  return lines.join('\n')
}
