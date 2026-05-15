import type { NapcatSegment } from './napcat-sender.js'

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

  return segments
}

