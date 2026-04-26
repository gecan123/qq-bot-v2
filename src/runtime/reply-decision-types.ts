import type { ReplyRecord } from '../conversation/reply-record-store.js'
import type { ActionRecord } from './action-record-store.js'
import type { ProactiveJudgeAdvice } from './proactive-judge.js'

export type ReplyOpportunitySourceKind = 'mention' | 'ambient_message' | 'private_message'
export type ReplyCueStrength = 'strong' | 'weak'
export type ReplyDeliveryMode = 'reply_to_message' | 'send_message' | 'send_private_message' | 'audit_only'

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
  judgeAdvice?: ProactiveJudgeAdvice
  createdAt: Date
}

export type ReplyDecisionOutcome =
  | 'sendable_reply'
  | 'opportunity_detected'
  | 'policy_suppressed'
  | 'no_intent'
  | 'would_reply_dry_run'

export interface ReplyPolicyResult {
  shouldGenerate: boolean
  shouldCreateReplyRecord: boolean
  shouldDeliver: boolean
  shouldAudit: boolean
  artifactKind?: 'proactive_candidate'
  auditKind?: string
  reason: string
  gateReasons?: string[]
  policyReasons?: string[]
  judgeAdvice?: ProactiveJudgeAdvice
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
  artifact?: import('./types.js').ProactiveCandidateArtifact
  deliveryResult?: 'sent' | 'failed' | 'dry_run' | 'skipped'
}
