export type ChatPlatform = 'qq' | 'feishu'

export type ConversationKind = 'group' | 'private'

export interface ConversationRef {
  platform: ChatPlatform
  accountId: string
  kind: ConversationKind
  externalId: string
}

export interface ParticipantRef {
  platform: ChatPlatform
  accountId: string
  externalId: string
}

export function conversationKey(conversation: ConversationRef): string {
  return [
    conversation.platform,
    encodeURIComponent(conversation.accountId),
    conversation.kind,
    encodeURIComponent(conversation.externalId),
  ].join(':')
}

export function participantKey(participant: ParticipantRef): string {
  return [
    participant.platform,
    encodeURIComponent(participant.accountId),
    encodeURIComponent(participant.externalId),
  ].join(':')
}
