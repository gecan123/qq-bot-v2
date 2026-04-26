import { createHash } from 'node:crypto'

export interface ForumItemContentHashInput {
  title: string
  url?: string | null
  author?: string | null
  rawContent?: string | null
}

export function computeForumItemContentHash(input: ForumItemContentHashInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      title: input.title,
      url: input.url ?? null,
      author: input.author ?? null,
      rawContent: input.rawContent ?? null,
    }))
    .digest('hex')
}

export function buildForumReadIdempotencyKey(feedItemId: string, contentHash?: string | null): string {
  return `forum-item:${feedItemId}:content:${contentHash ?? 'no-content-hash'}`
}
