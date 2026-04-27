export interface MentionEvent {
  groupId: number
  messageId: number
  messageRowId?: number
  senderId: number
  createdAt: number
  runtimeOpportunityId?: string
  runtimeDecisionId?: string
  runtimeSceneId?: string
}

export interface GroupConversationBatch {
  groupId: number
  events: MentionEvent[]
  openedAt: number
  closedAt: number
}

export interface ConversationWorkerResult {
  leftoverEvents: MentionEvent[]
  deliveryResults?: Array<'sent' | 'failed' | 'dry_run' | 'skipped'>
}
