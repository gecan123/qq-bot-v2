import { open } from 'node:fs/promises'

export interface BoundedTextTail {
  content: string
  truncated: boolean
}

export async function readBoundedTextTail(path: string, maxBytes: number): Promise<BoundedTextTail> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer')
  }
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(size, maxBytes)
    const start = size - length
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const raw = buffer.toString('utf8')
    if (start === 0) return { content: raw, truncated: false }
    const firstNewline = raw.indexOf('\n')
    return {
      content: firstNewline < 0 ? '' : raw.slice(firstNewline + 1),
      truncated: true,
    }
  } finally {
    await handle.close()
  }
}
