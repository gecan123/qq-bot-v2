import type { AtSegment, ParsedSegment } from '../types/message-segments.js'
import type { ConversationQueue } from '../queue/conversation-queue.js'

export interface MentionDispatchInput {
  groupId: number
  messageId: number
  senderId: number
  createdAt: number
  segments: ParsedSegment[]
}

export interface MentionDispatcher {
  dispatchIfMentioned(input: MentionDispatchInput): boolean
}

export interface MentionDispatcherOptions {
  selfNumber: number
  queue: ConversationQueue
}

function isMentionedSelf(segments: ParsedSegment[], selfNumber: number): boolean {
  return segments.some(
    (segment): segment is AtSegment => segment.type === 'at' && segment.targetId === String(selfNumber),
  )
}

export function createMentionDispatcher(options: MentionDispatcherOptions): MentionDispatcher {
  return {
    dispatchIfMentioned(input) {
      if (!isMentionedSelf(input.segments, options.selfNumber)) return false

      options.queue.enqueueMention({
        groupId: input.groupId,
        messageId: input.messageId,
        senderId: input.senderId,
        createdAt: input.createdAt,
      })
      return true
    },
  }
}
