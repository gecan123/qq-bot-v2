import type { NodeSegment } from 'node-napcat-ts'

export const QQ_FOLDED_TEXT_THRESHOLD_CHARS = 500
export const QQ_FOLDED_NODE_MAX_CHARS = 1_500
export const QQ_FOLDED_TEXT_MAX_CHARS = 20_000

interface OutboundSegment {
  type: string
  data: Readonly<Record<string, unknown>>
}

export type QqFoldedTextPlan =
  | { kind: 'not_applicable' }
  | { kind: 'too_long'; charCount: number; maxChars: number }
  | { kind: 'folded'; charCount: number; nodes: NodeSegment[] }

export function planQqFoldedText(
  segments: readonly OutboundSegment[],
  sender: { userId: number; nickname: string },
): QqFoldedTextPlan {
  if (segments.length !== 1 || segments[0]?.type !== 'text') return { kind: 'not_applicable' }
  const text = segments[0].data.text
  if (typeof text !== 'string') return { kind: 'not_applicable' }

  const charCount = unicodeLength(text)
  if (charCount <= QQ_FOLDED_TEXT_THRESHOLD_CHARS) return { kind: 'not_applicable' }
  if (charCount > QQ_FOLDED_TEXT_MAX_CHARS) {
    return { kind: 'too_long', charCount, maxChars: QQ_FOLDED_TEXT_MAX_CHARS }
  }

  const chunks = splitQqFoldedText(text)
  return {
    kind: 'folded',
    charCount,
    nodes: chunks.map((chunk, index) => ({
      type: 'node',
      data: {
        user_id: String(sender.userId),
        nickname: `${sender.nickname} · ${index + 1}/${chunks.length}`,
        content: [{ type: 'text', data: { text: chunk } }],
      },
    })),
  }
}

export function splitQqFoldedText(text: string): string[] {
  const chars = Array.from(text)
  if (chars.length <= QQ_FOLDED_NODE_MAX_CHARS) return [text]

  const chunks: string[] = []
  let start = 0
  while (start < chars.length) {
    const upper = Math.min(start + QQ_FOLDED_NODE_MAX_CHARS, chars.length)
    if (upper === chars.length) {
      chunks.push(chars.slice(start).join(''))
      break
    }
    const end = preferredBreak(chars, start, upper)
    chunks.push(chars.slice(start, end).join(''))
    start = end
  }
  return chunks
}

function preferredBreak(chars: readonly string[], start: number, upper: number): number {
  const lower = start + Math.floor(QQ_FOLDED_NODE_MAX_CHARS / 2)

  for (let index = upper; index > lower; index -= 1) {
    if (chars[index - 2] === '\n' && chars[index - 1] === '\n') return index
  }
  for (let index = upper; index > lower; index -= 1) {
    if (chars[index - 1] === '\n') return index
  }
  for (let index = upper; index > lower; index -= 1) {
    if (/[。！？!?；;]/u.test(chars[index - 1] ?? '')) return index
  }
  for (let index = upper; index > lower; index -= 1) {
    if (/\s/u.test(chars[index - 1] ?? '')) return index
  }
  return upper
}

function unicodeLength(text: string): number {
  return Array.from(text).length
}
