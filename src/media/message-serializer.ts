import type { ParsedSegment } from '../types/message-segments.js'
import { getMediaDescriptionText } from './media-description.js'

function serializeSegment(segment: ParsedSegment): string {
  switch (segment.type) {
    case 'text':
      return segment.content
    case 'image': {
      const label = segment.subType === 1 ? '[贴纸]' : '[图片]'
      const text = getMediaDescriptionText(segment.mediaDescription)
      return text ? `${label} ${text}` : label
    }
    case 'video': {
      const text = getMediaDescriptionText(segment.mediaDescription)
      return text ? `[视频] ${text}` : '[视频]'
    }
    case 'record': {
      const text = getMediaDescriptionText(segment.mediaDescription)
      return text ? `[语音] ${text}` : '[语音]'
    }
    case 'file': {
      const text = getMediaDescriptionText(segment.mediaDescription)
      if (text) return `[文件] ${text}`
      if (segment.fileName) return `[文件] ${segment.fileName}`
      return '[文件]'
    }
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
