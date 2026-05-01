import { makeMentionReplyIntentId, makePrivateReplyIntentId } from './types.js'
import type { ReplyDecision, ReplyOpportunity } from './reply-decision-types.js'

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export interface ReplyDecisionEngine {
  decide(opportunity: ReplyOpportunity): ReplyDecision
}

export interface ReplyDecisionEngineOptions {
  // 占位, 当前没用; 保留是为了未来加 policy switch 不破坏调用方签名
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
}

/**
 * Phase 1.5 之后简化版: 只处理 mention (强锚点) + private_message。
 * 主动发言路径已砍 (proactive-judge / candidate / ambient 的整套链路)。
 * 未来要做主动发言, 走"trigger → agent 自己用 send_message tool"的路径,
 * 不再走 ReplyOpportunity 这一套。
 */
export function createReplyDecisionEngine(_options: ReplyDecisionEngineOptions = {}): ReplyDecisionEngine {
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

      if (
        opportunity.sourceKind === 'private_message' &&
        opportunity.deliveryMode === 'send_private_message' &&
        (opportunity.mustReplyOverride || replyProbability >= 1)
      ) {
        const anchorRowId = opportunity.anchorMessageRowId ?? opportunity.triggerMessageRowId
        const userId = opportunity.targetUserId ?? opportunity.groupId
        return {
          opportunity: {
            ...opportunity,
            targetUserId: userId,
            replyProbability: opportunity.mustReplyOverride ? 1 : replyProbability,
            dryRun: opportunity.dryRun,
            deliveryMode: 'send_private_message',
          },
          outcome: 'sendable_reply',
          policy: {
            shouldGenerate: true,
            shouldCreateReplyRecord: true,
            shouldDeliver: true,
            shouldAudit: opportunity.dryRun,
            auditKind: opportunity.dryRun ? 'dry_run_intent' : undefined,
            reason: 'private message is sendable private_reply action',
          },
          replyIntentId: makePrivateReplyIntentId(userId, anchorRowId),
          deliveryMode: 'send_private_message',
          dryRun: opportunity.dryRun,
          reason: opportunity.reason,
        }
      }

      // 不是 mention 也不是私聊, 直接 no_intent 不做任何事
      return {
        opportunity: { ...opportunity, replyProbability, dryRun: true, deliveryMode: 'audit_only' },
        outcome: 'no_intent',
        policy: {
          shouldGenerate: false,
          shouldCreateReplyRecord: false,
          shouldDeliver: false,
          shouldAudit: false,
          reason: 'no actionable reply opportunity',
        },
        deliveryMode: 'audit_only',
        dryRun: true,
        reason: opportunity.reason,
      }
    },
  }
}
