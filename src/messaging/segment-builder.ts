import type { NapcatSegment } from './napcat-sender.js'

export interface MusicShare {
  platform: 'qq' | '163' | 'kugou' | 'kuwo' | 'migu' | 'custom'
  id?: string
  url?: string
  image?: string
  title?: string
  singer?: string
  content?: string
}

export interface BuildReplySegmentsInput {
  replyToMessageId: number
  mentionUserId?: number
  text: string
}

export function buildReplySegments(input: BuildReplySegmentsInput): NapcatSegment[] {
  const segments: NapcatSegment[] = [
    { type: 'reply', data: { id: String(input.replyToMessageId) } },
  ]

  if (input.mentionUserId !== undefined) {
    segments.push({ type: 'at', data: { qq: String(input.mentionUserId) } })
  }

  const text = input.mentionUserId !== undefined ? ` ${input.text}` : input.text
  segments.push({ type: 'text', data: { text } })
  return segments
}

export interface BuildOutboundSegmentsInput {
  replyToMessageId?: number
  mentionUserId?: number
  text?: string
  imageBytes?: Buffer
  music?: MusicShare
}

export function buildOutboundSegments(input: BuildOutboundSegmentsInput): NapcatSegment[] {
  const segments: NapcatSegment[] = []

  if (input.replyToMessageId !== undefined) {
    segments.push({ type: 'reply', data: { id: String(input.replyToMessageId) } })
  }

  if (input.mentionUserId !== undefined) {
    segments.push({ type: 'at', data: { qq: String(input.mentionUserId) } })
  }

  if (input.text !== undefined) {
    const text = input.mentionUserId !== undefined ? ` ${input.text}` : input.text
    segments.push({ type: 'text', data: { text } })
  }

  if (input.imageBytes !== undefined) {
    segments.push({
      type: 'image',
      data: { file: `base64://${input.imageBytes.toString('base64')}` },
    })
  }

  if (input.music !== undefined) {
    const { platform, ...data } = input.music
    segments.push({
      type: 'music',
      data: { type: platform, ...data },
    })
  }

  return segments
}
