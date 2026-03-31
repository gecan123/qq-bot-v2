export interface MentionEvent {
  groupId: number
  messageId: number
  senderId: number
  createdAt: number
}

export interface GroupConversationBatch {
  groupId: number
  events: MentionEvent[]
  openedAt: number
  closedAt: number
}

