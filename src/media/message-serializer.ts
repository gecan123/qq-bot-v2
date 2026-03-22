import type { ParsedSegment } from '../types/message-segments.js'

function serializeSegment(segment: ParsedSegment): string {
  switch (segment.type) {
    case 'text':
      return segment.content
    case 'image': {
      const label = segment.subType === 1 ? '[贴纸]' : '[图片]'
      return segment.summary ? `${label} ${segment.summary}` : label
    }
    case 'video':
      return segment.description ? `[视频] ${segment.description}` : '[视频]'
    case 'record':
      return segment.description ? `[语音] ${segment.description}` : '[语音]'
    case 'file':
      if (segment.description) return `[文件] ${segment.description}`
      if (segment.fileName) return `[文件] ${segment.fileName}`
      return '[文件]'
    case 'face':
      return segment.name ? `[表情: ${segment.name}]` : '[表情]'
    case 'at':
      return segment.targetName ? `@${segment.targetName}` : `@${segment.targetId}`
    case 'reply':
      return `[回复消息 ${segment.messageId}]`
    case 'json_card': {
      const parts: string[] = []
      if (segment.title) parts.push(segment.title)
      if (segment.desc) parts.push(segment.desc)
      if (segment.url) parts.push(segment.url)
      if (parts.length > 0) {
        const label = segment.source ? `分享(${segment.source})` : '分享'
        return `[${label}: ${parts.join(' - ')}]`
      }
      return segment.prompt ? `[分享: ${segment.prompt}]` : '[分享]'
    }
    case 'raw':
      return `[${segment.originalType}]`
  }
}

export function serializeForLLM(segments: ParsedSegment[], senderName?: string): string {
  const content = segments.map(serializeSegment).join('')
  return senderName ? `[${senderName}]\n${content}` : content
}
