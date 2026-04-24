export interface MentionEvent {
  groupId: number
  messageId: number
  messageRowId?: number
  senderId: number
  createdAt: number
}

export interface GroupConversationBatch {
  groupId: number
  events: MentionEvent[]
  openedAt: number
  closedAt: number
}

export interface ConversationWorkerResult {
  leftoverEvents: MentionEvent[]
}
