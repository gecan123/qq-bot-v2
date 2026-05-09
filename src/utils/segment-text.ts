import type { ParsedSegment } from '../types/message-segments.js'
import { formatMediaDescription } from '../media/media-description.js'

function renderMediaSegment(label: string, value: unknown): string {
  const formatted = formatMediaDescription(value)
  if (!formatted) return `[${label}]`
  const head = formatted.detectedType ? `${label}(${formatted.detectedType})` : label
  return `[${head}: ${formatted.body}]`
}

export function segmentsToPlainText(segments: ParsedSegment[]): string {
  return segments
    .map((seg) => {
      switch (seg.type) {
        case 'text':
          return seg.content
        case 'image':
          return renderMediaSegment('图片', seg.mediaDescription)
        case 'video':
          return renderMediaSegment('视频', seg.mediaDescription)
        case 'record':
          return renderMediaSegment('语音', seg.mediaDescription)
        case 'file': {
          const formatted = formatMediaDescription(seg.mediaDescription)
          if (!formatted) return seg.fileName ? `[文件: ${seg.fileName}]` : '[文件]'
          const head = seg.fileName ? `文件(${seg.fileName})` : '文件'
          return `[${head}: ${formatted.body}]`
        }
        case 'face':
          return seg.name ? `[表情: ${seg.name}]` : '[表情]'
        case 'at':
          return seg.targetName ? `@${seg.targetName}` : `@${seg.targetId}`
        case 'reply':
          return ''
        case 'json_card': {
          const parts: string[] = []
          if (seg.title) parts.push(seg.title)
          if (seg.desc) parts.push(seg.desc)
          if (seg.url) parts.push(seg.url)
          if (parts.length > 0) {
            const label = seg.source ? `分享(${seg.source})` : '分享'
            return `[${label}: ${parts.join(' - ')}]`
          }
          return seg.prompt ? `[分享: ${seg.prompt}]` : '[分享]'
        }
        case 'raw':
          return `[${seg.originalType}]`
        default:
          return ''
      }
    })
    .join('')
    .trim()
}
