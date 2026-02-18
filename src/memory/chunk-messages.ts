import type { Message } from '../generated/prisma/client.js'

export function chunkByTimeGap(messages: Message[], gapMinutes: number): Message[][] {
  if (messages.length === 0) return []
  const gapMs = gapMinutes * 60 * 1000
  const chunks: Message[][] = []
  let current: Message[] = [messages[0]]
  for (let i = 1; i < messages.length; i++) {
    const gap = messages[i].createdAt.getTime() - messages[i - 1].createdAt.getTime()
    if (gap > gapMs) {
      chunks.push(current)
      current = []
    }
    current.push(messages[i])
  }
  chunks.push(current)
  return chunks
}

export function addOverlap(chunks: Message[][], overlapSize: number): Message[][] {
  return chunks.map((chunk, i) => {
    if (i === 0) return chunk
    const overlap = chunks[i - 1].slice(-overlapSize)
    return [...overlap, ...chunk]
  })
}
