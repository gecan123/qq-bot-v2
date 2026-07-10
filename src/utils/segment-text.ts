import type { ParsedSegment } from '../types/message-segments.js'
import { formatMediaDescription } from '../media/media-description.js'

function renderForwardSegment(segment: Extract<ParsedSegment, { type: 'forward' }>): string {
  if (segment.unavailable) return '[合并转发消息: 内容不可用]'

  const lines = segment.items.map((item) => {
    const sender = item.senderName && item.senderId
      ? `${item.senderName}(${item.senderId})`
      : item.senderName ?? item.senderId ?? '未知发送者'
    const content = segmentsToPlainText(item.content) || '[空消息]'
    return `${sender}: ${content}`
  })
  if (segment.truncated) lines.push('…（转发内容已截断）')
  return ['[合并转发消息]', ...lines, '[转发结束]'].join('\n')
}

function renderMediaSegment(label: string, referenceId: string | undefined, value: unknown): string {
  const tag = referenceId ? `${label}#${referenceId}` : label
  const formatted = formatMediaDescription(value)
  if (!formatted) return `[${tag}]`
  const head = formatted.detectedType ? `${tag}(${formatted.detectedType})` : tag
  return `[${head}: ${formatted.body}]`
}

export function segmentsToPlainText(segments: ParsedSegment[]): string {
  return segments
    .map((seg) => {
      switch (seg.type) {
        case 'text':
          return seg.content
        case 'image':
          return renderMediaSegment('图片', seg.referenceId, seg.mediaDescription)
        case 'video':
          return renderMediaSegment('视频', seg.referenceId, seg.mediaDescription)
        case 'record':
          return renderMediaSegment('语音', seg.referenceId, seg.mediaDescription)
        case 'file': {
          const tag = seg.referenceId ? `文件#${seg.referenceId}` : '文件'
          const formatted = formatMediaDescription(seg.mediaDescription)
          if (!formatted) return seg.fileName ? `[${tag}: ${seg.fileName}]` : `[${tag}]`
          const head = seg.fileName ? `${tag}(${seg.fileName})` : tag
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
        case 'forward':
          return renderForwardSegment(seg)
        case 'raw':
          return `[${seg.originalType}]`
        default:
          return ''
      }
    })
    .join('')
    .trim()
}
