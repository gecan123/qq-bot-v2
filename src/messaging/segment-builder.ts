interface NapcatSegment {
  type: string
  data: Record<string, string | number | boolean>
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

