export interface MentionEvent {
  groupId: number
  messageId: number
  senderId: number
  createdAt: number
}

export interface GroupConversationBatch {
  groupId: number
  events: MentionEvent[]
  /** 自上次评估以来的普通消息数量（不含 mention） */
  messagesSinceLastEval: number
  openedAt: number
  closedAt: number
}

export interface ConversationWorkerResult {
  leftoverEvents: MentionEvent[]
}
