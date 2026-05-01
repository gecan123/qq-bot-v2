import type { ReplyRecord } from '../conversation/reply-record-store.js'
import type { ActionRecord } from './action-record-store.js'

export type ReplyOpportunitySourceKind = 'mention' | 'private_message'
export type ReplyCueStrength = 'strong'
export type ReplyDeliveryMode = 'reply_to_message' | 'send_private_message' | 'audit_only'

export interface ReplyOpportunity {
  opportunityId: string
  decisionId?: string
  runtimeKey: string
  groupId: number
  targetUserId?: number
  sceneId: string
  scopeKey: string
  sourceKind: ReplyOpportunitySourceKind
  cueStrength: ReplyCueStrength
  mustReplyOverride: boolean
  replyProbability: number
  anchorMessageRowId?: number
  triggerMessageRowId: number
  triggerMessageId: number
  triggerSenderId: number
  incorporatedMessageRowId: number
  incorporatedMessageId: number
  deliveryMode: ReplyDeliveryMode
  dryRun: boolean
  reason: string
  gateReasons?: string[]
  createdAt: Date
}

export type ReplyDecisionOutcome =
  | 'sendable_reply'
  | 'policy_suppressed'
  | 'no_intent'

export interface ReplyPolicyResult {
  shouldGenerate: boolean
  shouldCreateReplyRecord: boolean
  shouldDeliver: boolean
  shouldAudit: boolean
  auditKind?: string
  reason: string
  gateReasons?: string[]
  policyReasons?: string[]
}

export interface ReplyDecision {
  opportunity: ReplyOpportunity
  outcome: ReplyDecisionOutcome
  policy: ReplyPolicyResult
  replyIntentId?: string
  legacyReplyIntentId?: string
  deliveryMode: ReplyDeliveryMode
  dryRun: boolean
  reason: string
}

export interface ReplyExecutionResult {
  decision: ReplyDecision
  replyRecord?: ReplyRecord
  actionRecord?: ActionRecord
  deliveryResult?: 'sent' | 'failed' | 'dry_run' | 'skipped'
}
