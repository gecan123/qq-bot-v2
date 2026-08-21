import type { ChatPlatform, ConversationRef } from '../chat/conversation.js'
import {
  appendMessageFact,
  findLatestMessageFact,
  type AppendMessageFactParams,
  type PersistedMessageFact,
} from '../database/messages.js'

export interface MessageRecallInput {
  platform: ChatPlatform
  accountId: string
  eventExternalId: string
  messageExternalId: string
  conversationExternalId?: string
  recalledAt: number
  rawContent?: unknown
}

export interface MessageRecallOriginal {
  conversation: ConversationRef
  conversationName?: string
  senderExternalId: string
  senderName?: string
}

export interface MessageRecallDeps {
  findOriginal(input: {
    platform: ChatPlatform
    accountId: string
    messageExternalId: string
    conversationExternalId?: string
  }): Promise<MessageRecallOriginal | null>
  appendFact(input: AppendMessageFactParams): Promise<PersistedMessageFact>
}

export async function persistMessageRecall(
  input: MessageRecallInput,
  deps: MessageRecallDeps = {
    findOriginal: findLatestMessageFact,
    appendFact: appendMessageFact,
  },
): Promise<PersistedMessageFact | null> {
  const original = await deps.findOriginal({
    platform: input.platform,
    accountId: input.accountId,
    messageExternalId: input.messageExternalId,
    ...(input.conversationExternalId ? { conversationExternalId: input.conversationExternalId } : {}),
  })
  if (!original) return null
  return deps.appendFact({
    eventKind: 'recall',
    eventExternalId: input.eventExternalId,
    conversation: original.conversation,
    ...(original.conversationName ? { conversationName: original.conversationName } : {}),
    messageExternalId: input.messageExternalId,
    senderExternalId: original.senderExternalId,
    ...(original.senderName ? { senderName: original.senderName } : {}),
    content: [],
    ...(input.rawContent === undefined ? {} : { rawContent: input.rawContent }),
    sentAt: input.recalledAt,
  })
}
