import type { ParsedSegment } from '../types/message-segments.js'

export function segmentsToPlainText(segments: ParsedSegment[]): string {
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
