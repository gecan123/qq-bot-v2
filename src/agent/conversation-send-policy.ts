import type { ConversationRef } from '../chat/conversation.js'

export type SendMode = 'ambient' | 'reply'

export type SendAuthorization =
  | { allowed: true }
  | { allowed: false; error: string }

export interface ConversationSendPolicy {
  authorize(input: {
    target: ConversationRef
    mode: SendMode
    replyToExternalId?: string
  }): Promise<SendAuthorization>
}
