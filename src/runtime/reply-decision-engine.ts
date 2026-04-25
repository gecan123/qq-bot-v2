import { makeMentionReplyIntentId } from './types.js'
import type { ReplyDecision, ReplyOpportunity } from './reply-decision-types.js'
import { config } from '../config/index.js'
import type { ProactiveJudgeAdvice, ProactiveJudgePolicy } from './proactive-judge.js'

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export interface ReplyDecisionEngine {
  decide(opportunity: ReplyOpportunity): ReplyDecision
}

export interface ReplyDecisionEngineOptions {
  ambientAuditEnabled?: boolean
  proactiveJudge?: Pick<
    ProactiveJudgePolicy,
    | 'minConfidence'
    | 'minUsefulness'
    | 'minNovelty'
    | 'maxInterruptionCost'
    | 'maxSocialRisk'
  >
}

export function createReplyDecisionEngine(options: ReplyDecisionEngineOptions = {}): ReplyDecisionEngine {
  const ambientAuditEnabled = options.ambientAuditEnabled ?? true
  const proactiveJudge = options.proactiveJudge ?? config.proactiveJudge

  const getJudgePolicyReasons = (advice: ProactiveJudgeAdvice | undefined): string[] => {
    if (!advice) return ['judge_missing']
    if (advice.status !== 'valid') return [`judge_${advice.status}`]

    const reasons: string[] = []
    if (!advice.shouldSpeak) reasons.push('judge_veto')
    if (advice.confidence < proactiveJudge.minConfidence) reasons.push('judge_low_confidence')
    if (advice.usefulness < proactiveJudge.minUsefulness) reasons.push('judge_low_usefulness')
    if (advice.novelty < proactiveJudge.minNovelty) reasons.push('judge_low_novelty')
    if (advice.interruptionCost > proactiveJudge.maxInterruptionCost) reasons.push('judge_high_interruption_cost')
    if (advice.socialRisk > proactiveJudge.maxSocialRisk) reasons.push('judge_high_social_risk')
    if ((advice.suggestedDelayMs ?? 0) > 0) reasons.push('judge_suggested_delay_unsupported')
    return reasons
  }

  return {
    decide(opportunity) {
      const replyProbability = clampProbability(opportunity.replyProbability)

      const isStrongAnchoredOpportunity =
        opportunity.deliveryMode === 'reply_to_message' &&
        opportunity.anchorMessageRowId != null &&
        (opportunity.mustReplyOverride || replyProbability >= 1)

      if (isStrongAnchoredOpportunity) {
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
      const gateReasons = opportunity.gateReasons ?? []
      const judgePolicyReasons =
        opportunity.deliveryMode === 'send_message' && replyProbability > 0 && gateReasons.length === 0
          ? getJudgePolicyReasons(opportunity.judgeAdvice)
          : []
      const policyReasons = [...gateReasons, ...judgePolicyReasons]
      const shouldGenerateProactiveCandidate =
        opportunity.deliveryMode === 'send_message' &&
        replyProbability > 0 &&
        gateReasons.length === 0 &&
        judgePolicyReasons.length === 0
      const proactiveSuppressed = opportunity.deliveryMode === 'send_message' && policyReasons.length > 0
      return {
        opportunity: {
          ...opportunity,
          replyProbability,
          dryRun: true,
          deliveryMode: shouldGenerateProactiveCandidate ? 'send_message' : 'audit_only',
        },
        outcome: shouldGenerateProactiveCandidate ? 'would_reply_dry_run' : outcome,
        policy: {
          shouldGenerate: shouldGenerateProactiveCandidate,
          shouldCreateReplyRecord: false,
          shouldDeliver: false,
          shouldAudit: true,
          artifactKind: shouldGenerateProactiveCandidate ? 'proactive_candidate' : undefined,
          auditKind: shouldGenerateProactiveCandidate || proactiveSuppressed ? 'proactive_candidate' : outcome,
          reason: opportunity.reason,
          gateReasons,
          policyReasons,
          judgeAdvice: opportunity.judgeAdvice,
        },
        replyIntentId: shouldGenerateProactiveCandidate ? opportunity.opportunityId : undefined,
        deliveryMode: shouldGenerateProactiveCandidate ? 'send_message' : 'audit_only',
        dryRun: true,
        reason: opportunity.reason,
      }
    },
  }
}
