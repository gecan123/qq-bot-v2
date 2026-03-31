import type { MentionEvent } from '../conversation/types.js'

export interface ConversationQueue {
  enqueueMention(event: MentionEvent): void
  start(): void
  stop(): void
}

