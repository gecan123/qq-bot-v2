import { makeMentionReplyIntentId } from './types.js'
import type { ReplyDecision, ReplyOpportunity } from './reply-decision-types.js'

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export interface ReplyDecisionEngine {
  decide(opportunity: ReplyOpportunity): ReplyDecision
}

export interface ReplyDecisionEngineOptions {
  ambientAuditEnabled?: boolean
}

export function createReplyDecisionEngine(options: ReplyDecisionEngineOptions = {}): ReplyDecisionEngine {
  const ambientAuditEnabled = options.ambientAuditEnabled ?? true

  return {
    decide(opportunity) {
      const replyProbability = clampProbability(opportunity.replyProbability)

      if (opportunity.sourceKind === 'mention' || opportunity.mustReplyOverride) {
        const anchorRowId = opportunity.anchorMessageRowId ?? opportunity.triggerMessageRowId
        return {
          opportunity: {
            ...opportunity,
            replyProbability: opportunity.mustReplyOverride ? 1 : replyProbability,
            dryRun: opportunity.dryRun,
            deliveryMode: 'reply_to_message',
          },
          outcome: 'sendable_reply',
          policy: {
            shouldGenerate: true,
            shouldCreateReplyRecord: true,
            shouldDeliver: true,
            shouldAudit: opportunity.dryRun,
            auditKind: opportunity.dryRun ? 'dry_run_intent' : undefined,
            reason: opportunity.mustReplyOverride
              ? 'strong mention mustReplyOverride forces anchored reply'
              : 'mention opportunity is sendable anchored reply',
          },
          replyIntentId: makeMentionReplyIntentId(opportunity.groupId, anchorRowId),
          legacyReplyIntentId: `${opportunity.runtimeKey}:${opportunity.scopeKey}:${anchorRowId}:${opportunity.incorporatedMessageRowId}`,
          deliveryMode: 'reply_to_message',
          dryRun: opportunity.dryRun,
          reason: opportunity.reason,
        }
      }

      if (!ambientAuditEnabled) {
        return {
          opportunity: { ...opportunity, replyProbability, dryRun: true, deliveryMode: 'audit_only' },
          outcome: 'policy_suppressed',
          policy: {
            shouldGenerate: false,
            shouldCreateReplyRecord: false,
            shouldDeliver: false,
            shouldAudit: false,
            reason: 'ambient audit disabled',
          },
          deliveryMode: 'audit_only',
          dryRun: true,
          reason: 'ambient audit disabled',
        }
      }

      const outcome = replyProbability > 0 ? 'opportunity_detected' : 'policy_suppressed'
      return {
        opportunity: { ...opportunity, replyProbability, dryRun: true, deliveryMode: 'audit_only' },
        outcome,
        policy: {
          shouldGenerate: false,
          shouldCreateReplyRecord: false,
          shouldDeliver: false,
          shouldAudit: true,
          auditKind: outcome,
          reason: opportunity.reason,
        },
        deliveryMode: 'audit_only',
        dryRun: true,
        reason: opportunity.reason,
      }
    },
  }
}
