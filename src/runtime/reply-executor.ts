import { createLogger } from '../logger.js'
import { getMessageById, getMessageBySceneMessageId } from '../database/messages.js'
import type { Message } from '../generated/prisma/client.js'
import { resolveMessage } from '../media/message-resolver.js'
import { messageSender, type MessageSender } from '../messaging/message-sender.js'
import { generateMentionReply, generateProactiveCandidateReply } from '../responder/reply-generator.js'
import type { ProactiveCandidateReplyResult } from '../responder/reply-generator.js'
import type { IncomingMessage } from '../responder/pipeline.js'
import { createReplyAudit, createOrReuseReplyAudit } from '../conversation/reply-audit-store.js'
import type { ReplyDeliveryPayload, ReplyRecord } from '../conversation/reply-record-store.js'
import { createReplyDecisionEngine, type ReplyDecisionEngine } from './reply-decision-engine.js'
import type { ReplyDecision, ReplyExecutionResult, ReplyOpportunity } from './reply-decision-types.js'
import type { ProactiveCandidateArtifact, ProactiveCandidateStatus } from './types.js'
import { previewText, type BusinessLogDispatchMode, type BusinessLogSideEffect } from '../utils/business-log.js'
import { createOrReuseActionIntent, createOrReuseActionRecord, markActionRecordDeliveryState } from './action-record-store.js'

type StoredConversationMessage = NonNullable<Awaited<ReturnType<typeof getMessageById>>>

const log = createLogger('REPLY_EXECUTOR')

function normalizeGeneratedReply(result: string | null | ProactiveCandidateReplyResult): ProactiveCandidateReplyResult {
  if (typeof result === 'string' || result === null) {
    return { text: result, termination: result?.trim() ? 'final_answer' : 'no_final_answer' }
  }
  return result
}

export interface ReplyExecutorOptions {
  decisionEngine?: ReplyDecisionEngine
  generateReply?: (message: IncomingMessage, opportunity: ReplyOpportunity) => Promise<string | null | ProactiveCandidateReplyResult>
  generateProactiveCandidateReply?: (message: IncomingMessage, opportunity: ReplyOpportunity) => Promise<ProactiveCandidateReplyResult>
  buildIncomingMessage?: (opportunity: ReplyOpportunity) => Promise<IncomingMessage | null>
  sender?: MessageSender
  replyRecordStore?: {
    findByReplyIntentId: (runtimeKey: string, replyIntentId: string) => Promise<ReplyRecord | null>
    createOrReuse: (input: {
      runtimeKey: string
      groupId: number
      scopeKey: string
      replyIntentId: string
      sourceKind: string
      triggerMessageRowId?: number | null
      incorporatedMessageRowId?: number | null
      deliveryPayload: ReplyDeliveryPayload
      text: string
      executionState?: ReplyRecord['executionState']
    }) => Promise<ReplyRecord>
    markAcked: (id: number, providerMessageId: number) => Promise<void>
    markSending: (id: number) => Promise<void>
    markSent: (id: number) => Promise<void>
    markFailed: (id: number) => Promise<void>
  }
  replyAuditStore?: {
    create?: typeof createReplyAudit
    createOrReuse?: typeof createOrReuseReplyAudit
  }
  actionRecordStore?: {
    createOrReuseIntent: typeof createOrReuseActionIntent
    createOrReuseRecord: typeof createOrReuseActionRecord
    markDeliveryState: typeof markActionRecordDeliveryState
  }
  proactiveCandidateStore?: {
    createOrReuse: (artifact: ProactiveCandidateArtifact) => Promise<void>
  }
  onProactiveGenerationAttempt?: (opportunity: ReplyOpportunity) => Promise<void>
  deliver?: unknown
  onReplyRecordSent?: (record: ReplyRecord) => Promise<void>
}

export interface ReplyExecutor {
  execute(opportunity: ReplyOpportunity): Promise<ReplyExecutionResult>
}


async function defaultBuildIncomingMessage(opportunity: ReplyOpportunity): Promise<IncomingMessage | null> {
  const stored = opportunity.sourceKind === 'private_message'
    ? (await getMessageBySceneMessageId({
        sceneKind: 'qq_private',
        sceneExternalId: opportunity.targetUserId ?? opportunity.groupId,
        messageId: opportunity.incorporatedMessageId,
      })) as StoredConversationMessage | null
    : (await getMessageById(opportunity.groupId, opportunity.incorporatedMessageId)) as StoredConversationMessage | null
  if (!stored) return null
  const segments = await resolveMessage(stored as Message, { timeoutMs: 0 })
  return {
    groupId: Number(stored.groupId),
    sceneKind: opportunity.sourceKind === 'private_message' ? 'qq_private' : 'qq_group',
    sceneExternalId: opportunity.sourceKind === 'private_message'
      ? String(opportunity.targetUserId ?? opportunity.groupId)
      : String(opportunity.groupId),
    sceneId: opportunity.sceneId,
    groupName: stored.groupName ?? undefined,
    messageId: Number(stored.messageId),
    senderId: Number(stored.senderId),
    senderNickname: stored.senderGroupNickname ?? stored.senderNickname ?? String(stored.senderId),
    segments,
  }
}

function auditReplyIntentId(decision: ReplyDecision): string {
  return decision.replyIntentId ?? decision.opportunity.opportunityId
}

function buildDeliveryPayload(decision: ReplyDecision): ReplyDeliveryPayload {
  if (decision.deliveryMode === 'send_private_message') {
    return { type: 'send_private_message', userId: decision.opportunity.targetUserId ?? decision.opportunity.groupId }
  }

  if (decision.deliveryMode === 'send_message') {
    return { type: 'send_message', groupId: decision.opportunity.groupId }
  }

  return {
    type: 'reply_to_message',
    groupId: decision.opportunity.groupId,
    messageId: decision.opportunity.triggerMessageId,
    replyToMessageId: decision.opportunity.triggerMessageId,
    mentionUserId: decision.opportunity.triggerSenderId,
  }
}

function isDryRunEnabledForPayload(sender: MessageSender, payload: ReplyDeliveryPayload): boolean {
  if (payload.type === 'send_private_message') return sender.isReplyDryRunEnabled?.() ?? false
  return payload.type === 'send_message'
    ? (sender.isSendDryRunEnabled?.() ?? false)
    : (sender.isReplyDryRunEnabled?.() ?? false)
}

function buildProactiveCandidateArtifact(input: {
  decision: ReplyDecision
  reply: string | null
  termination: string
  status: ProactiveCandidateStatus
  tokenUsage?: ProactiveCandidateReplyResult['tokenUsage']
  tokenUsageState: NonNullable<ProactiveCandidateArtifact['tokenUsageState']>
  durationMs?: number
  now: Date
}): ProactiveCandidateArtifact {
  const opportunity = input.decision.opportunity
  const expiresAt = new Date(input.now.getTime() + 7 * 24 * 60 * 60 * 1000)
  return {
    artifactKind: 'proactive_candidate',
    opportunityId: opportunity.opportunityId,
    runtimeKey: opportunity.runtimeKey,
    groupId: opportunity.groupId,
    sceneId: opportunity.sceneId,
    sourceKind: opportunity.sourceKind,
    triggerMessageRowId: opportunity.triggerMessageRowId,
    incorporatedMessageRowId: opportunity.incorporatedMessageRowId,
    createdAt: input.now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    score: opportunity.replyProbability,
    gateReasons: input.decision.policy.gateReasons ?? [],
    policyReasons: input.decision.policy.policyReasons ?? [],
    judgeAdvice: input.decision.policy.judgeAdvice,
    candidateText: input.status === 'candidate_generated' ? input.reply ?? undefined : undefined,
    termination: input.termination,
    tokenUsage: input.tokenUsage,
    tokenUsageState: input.tokenUsageState,
    durationMs: input.durationMs,
    status: input.status,
  }
}

function isSupportedSendableGeneration(decision: ReplyDecision): boolean {
  return (
    (decision.deliveryMode === 'reply_to_message' && decision.opportunity.sourceKind === 'mention') ||
    (decision.deliveryMode === 'send_private_message' && decision.opportunity.sourceKind === 'private_message')
  )
}

function getDecisionDispatchMode(decision: ReplyDecision): BusinessLogDispatchMode {
  if (decision.policy.artifactKind === 'proactive_candidate') return 'artifact_only'
  if (decision.policy.shouldCreateReplyRecord) return decision.dryRun ? 'dry_run' : 'live'
  return 'audit_only'
}

function getDecisionSideEffect(decision: ReplyDecision): BusinessLogSideEffect {
  if (decision.policy.artifactKind === 'proactive_candidate') return 'artifact_write'
  if (decision.policy.shouldCreateReplyRecord) return 'action_record_write'
  if (decision.policy.shouldAudit) return 'audit_write'
  return 'none'
}

function buildActionResultPayload(input: {
  opportunity: ReplyOpportunity
  deliveryPayload: ReplyDeliveryPayload
  text: string
  replyIntentId: string
}): Record<string, unknown> {
  return {
    sourceRefs: {
      triggerMessageRowId: input.opportunity.triggerMessageRowId,
      incorporatedMessageRowId: input.opportunity.incorporatedMessageRowId,
      source: 'messages',
    },
    target: {
      sceneId: input.opportunity.sceneId,
      groupId: input.opportunity.groupId,
      userId: input.opportunity.targetUserId,
    },
    decisionId: input.opportunity.decisionId,
    deliveryPayload: input.deliveryPayload,
    proposedEffect: {
      type: input.deliveryPayload.type,
      text: input.text,
      replyIntentId: input.replyIntentId,
      sourceKind: input.opportunity.sourceKind,
    },
  }
}

function getStoredActionText(payload: Record<string, unknown> | null | undefined): string | null {
  const proposedEffect = payload?.proposedEffect
  const text =
    proposedEffect && typeof proposedEffect === 'object' && !Array.isArray(proposedEffect) &&
    typeof (proposedEffect as Record<string, unknown>).text === 'string'
      ? ((proposedEffect as Record<string, unknown>).text as string).trim()
      : ''
  return text || null
}

function getReplyTargetId(payload: ReplyDeliveryPayload): number | null {
  if (payload.type !== 'reply_to_message') return null
  const target = payload.replyToMessageId ?? payload.messageId
  return typeof target === 'number' && Number.isSafeInteger(target) ? target : null
}

export function createReplyExecutor(options: ReplyExecutorOptions = {}): ReplyExecutor {
  const decisionEngine = options.decisionEngine ?? createReplyDecisionEngine()
  const generateMentionReplyFn = options.generateReply ?? ((message: IncomingMessage) => generateMentionReply(message))
  const generateProactiveCandidateReplyFn =
    options.generateProactiveCandidateReply ??
    ((message: IncomingMessage) => generateProactiveCandidateReply(message))
  const sender = options.sender ?? messageSender
  const replyRecordStore = options.replyRecordStore
  const configuredReplyAuditStore = options.replyAuditStore
  const replyAuditStore = {
    create: configuredReplyAuditStore?.create ?? createReplyAudit,
    createOrReuse: configuredReplyAuditStore?.createOrReuse ?? configuredReplyAuditStore?.create ?? createOrReuseReplyAudit,
  }
  const actionRecordStore = options.actionRecordStore ?? {
    createOrReuseIntent: createOrReuseActionIntent,
    createOrReuseRecord: createOrReuseActionRecord,
    markDeliveryState: markActionRecordDeliveryState,
  }

  return {
    async execute(opportunity) {
      const decision = decisionEngine.decide(opportunity)
      log.info(
        {
          direction: 'internal',
          actor: 'system',
          category: opportunity.sourceKind === 'private_message'
            ? 'private_reply'
            : opportunity.sourceKind === 'mention'
              ? 'mention_reply'
              : 'ambient_candidate',
          flow: 'reply_decision',
          groupId: opportunity.groupId,
          sceneId: opportunity.sceneId,
          opportunityId: opportunity.opportunityId,
          sourceKind: opportunity.sourceKind,
          cueStrength: opportunity.cueStrength,
          outcome: decision.outcome,
          deliveryMode: decision.deliveryMode,
          dryRun: decision.dryRun,
          shouldGenerate: decision.policy.shouldGenerate,
          shouldCreateReplyRecord: decision.policy.shouldCreateReplyRecord,
          shouldDeliver: decision.policy.shouldDeliver,
          shouldAudit: decision.policy.shouldAudit,
          dispatchMode: getDecisionDispatchMode(decision),
          sideEffect: 'none',
          plannedSideEffect: getDecisionSideEffect(decision),
          replyProbability: decision.opportunity.replyProbability,
          gateReasons: decision.policy.gateReasons ?? [],
          policyReasons: decision.policy.policyReasons ?? [],
          judgeAdvice: decision.policy.judgeAdvice,
          reason: decision.policy.reason,
        },
        '回复决策完成',
      )

      if (decision.policy.artifactKind === 'proactive_candidate') {
        let reply: string | null = null
        let termination = 'policy_suppressed'
        let status: ProactiveCandidateStatus = 'suppressed'
        let tokenUsage: ProactiveCandidateReplyResult['tokenUsage']
        let durationMs: number | undefined
        let generationAttempted = false

        if (decision.policy.shouldGenerate) {
          const message = await (options.buildIncomingMessage ?? defaultBuildIncomingMessage)(decision.opportunity)
          if (!message) {
            termination = 'missing_incoming_message'
            status = 'no_candidate'
          } else {
            await options.onProactiveGenerationAttempt?.(decision.opportunity)
            generationAttempted = true
            const generated = normalizeGeneratedReply(await generateProactiveCandidateReplyFn(message, decision.opportunity))
            reply = generated.text
            termination = generated.termination
            tokenUsage = generated.tokenUsage
            durationMs = generated.durationMs
            if (reply?.trim()) {
              status = 'candidate_generated'
            } else {
              status = 'no_candidate'
            }
          }
        }
        const tokenUsageState = tokenUsage ? 'captured' : generationAttempted ? 'unknown' : 'not_applicable'

        const artifact = buildProactiveCandidateArtifact({
          decision,
          reply,
          termination,
          status,
          tokenUsage,
          tokenUsageState,
          durationMs,
          now: new Date(),
        })
        log.info(
          {
            direction: 'outbound',
            actor: 'bot',
            category: 'ambient_candidate',
            flow: 'proactive_candidate_generation',
            groupId: artifact.groupId,
            sceneId: artifact.sceneId,
            opportunityId: artifact.opportunityId,
            sourceKind: artifact.sourceKind,
            status: artifact.status,
            termination: artifact.termination,
            dispatchMode: 'artifact_only',
            sideEffect: status === 'candidate_generated' ? 'artifact_write' : 'audit_write',
            deliveryResult: 'skipped',
            gateReasons: artifact.gateReasons,
            triggerMessageRowId: artifact.triggerMessageRowId,
            incorporatedMessageRowId: artifact.incorporatedMessageRowId,
            textPreview: previewText(artifact.candidateText),
          },
          status === 'candidate_generated' ? '主动候选已生成（未发送）' : '主动候选未生成（未发送）',
        )

        if (status === 'candidate_generated') {
          await options.proactiveCandidateStore?.createOrReuse(artifact)
        }
        await replyAuditStore.createOrReuse({
          opportunityId: opportunity.opportunityId,
          runtimeKey: opportunity.runtimeKey,
          groupId: opportunity.groupId,
          scopeKey: opportunity.scopeKey,
          replyIntentId: auditReplyIntentId(decision),
          auditKind: 'proactive_candidate',
          payload: artifact,
        })

        return { decision, artifact, deliveryResult: 'skipped' }
      }

      if (decision.policy.shouldAudit && !decision.policy.shouldCreateReplyRecord) {
        await replyAuditStore.createOrReuse({
          opportunityId: opportunity.opportunityId,
          runtimeKey: opportunity.runtimeKey,
          groupId: opportunity.groupId,
          scopeKey: opportunity.scopeKey,
          replyIntentId: auditReplyIntentId(decision),
          auditKind: decision.policy.auditKind ?? decision.outcome,
          payload: {
            outcome: decision.outcome,
            sourceKind: opportunity.sourceKind,
            cueStrength: opportunity.cueStrength,
            deliveryMode: decision.deliveryMode,
            replyProbability: decision.opportunity.replyProbability,
            reason: decision.policy.reason,
            gateReasons: decision.policy.gateReasons ?? [],
            policyReasons: decision.policy.policyReasons ?? [],
            judgeAdvice: decision.policy.judgeAdvice,
          },
        })
        return { decision, deliveryResult: 'skipped' }
      }

      if (!decision.policy.shouldCreateReplyRecord) {
        return { decision, deliveryResult: 'skipped' }
      }

      const replyIntentId = decision.replyIntentId
      if (!replyIntentId) {
        throw new Error(`Reply decision requires replyIntentId for sendable outcome: ${opportunity.opportunityId}`)
      }

      const legacyReplyIntentId = decision.legacyReplyIntentId
      const existingRecord = replyRecordStore
        ? (await replyRecordStore.findByReplyIntentId(opportunity.runtimeKey, replyIntentId)) ??
          (legacyReplyIntentId && legacyReplyIntentId !== replyIntentId
            ? await replyRecordStore.findByReplyIntentId(opportunity.runtimeKey, legacyReplyIntentId)
            : null)
        : null

      let reply = existingRecord?.text ?? null
      if (!reply && decision.policy.shouldGenerate) {
        if (!isSupportedSendableGeneration(decision)) {
          log.warn(
            {
              opportunityId: opportunity.opportunityId,
              sourceKind: opportunity.sourceKind,
              deliveryMode: decision.deliveryMode,
            },
            'reply opportunity has unsupported sendable generation policy; skipping',
          )
          return { decision, deliveryResult: 'skipped' }
        }
        const message = await (options.buildIncomingMessage ?? defaultBuildIncomingMessage)(opportunity)
        if (!message) {
          log.warn({ opportunityId: opportunity.opportunityId }, 'reply opportunity missing incoming message; skipping')
          return { decision, deliveryResult: 'skipped' }
        }
        reply = normalizeGeneratedReply(await generateMentionReplyFn(message, opportunity)).text
      }

      if (!reply) {
        log.warn({ opportunityId: opportunity.opportunityId }, 'reply opportunity generated no formal reply')
        return { decision, deliveryResult: 'skipped' }
      }

      const deliveryPayload = buildDeliveryPayload(decision)
      const shouldDryRun = isDryRunEnabledForPayload(sender, deliveryPayload)
      const actionType = deliveryPayload.type === 'reply_to_message'
        ? 'send_group_reply'
        : deliveryPayload.type === 'send_private_message'
          ? 'send_private_message'
          : 'send_group_message'
      const actionIntent = await actionRecordStore.createOrReuseIntent({
        id: `${opportunity.opportunityId}:intent:${actionType}`,
        opportunityId: opportunity.opportunityId,
        decisionId: opportunity.decisionId,
        actionType,
        targetSceneId: opportunity.sceneId,
        payload: buildActionResultPayload({ opportunity, deliveryPayload, text: reply, replyIntentId }),
        dryRun: shouldDryRun,
        riskLevel: actionType === 'send_private_message' ? 'L2' : 'L3',
        status: shouldDryRun ? 'skipped' : 'approved',
        idempotencyKey: `${opportunity.opportunityId}:${actionType}`,
      })
      let actionRecord = await actionRecordStore.createOrReuseRecord({
        id: `${actionIntent.id}:record`,
        actionIntentId: actionIntent.id,
        actionType,
        targetSceneId: opportunity.sceneId,
        deliveryState: shouldDryRun ? 'dry_run' : 'pending',
        idempotencyKey: actionIntent.idempotencyKey,
        resultPayload: buildActionResultPayload({ opportunity, deliveryPayload, text: reply, replyIntentId }),
      })
      const actionText = getStoredActionText(actionRecord.resultPayload) ?? reply
      const replyRecord = replyRecordStore
        ? await replyRecordStore.createOrReuse({
            runtimeKey: opportunity.runtimeKey,
            groupId: opportunity.groupId,
            scopeKey: opportunity.scopeKey,
            replyIntentId: existingRecord?.replyIntentId ?? replyIntentId,
            sourceKind: opportunity.sourceKind,
            triggerMessageRowId: opportunity.triggerMessageRowId,
            incorporatedMessageRowId: opportunity.incorporatedMessageRowId,
            deliveryPayload,
            text: actionText,
            executionState: shouldDryRun ? 'dry_run' : 'pending',
          })
        : undefined

      if (actionRecord.deliveryState === 'sent' || actionRecord.deliveryState === 'acked') {
        if (replyRecord) {
          await replyRecordStore?.markSent(replyRecord.id)
          await options.onReplyRecordSent?.(replyRecord)
        }
        return { decision, replyRecord, actionRecord, deliveryResult: 'sent' }
      }

      if (actionRecord.deliveryState === 'dry_run') {
        await replyAuditStore.createOrReuse({
          opportunityId: opportunity.opportunityId,
          runtimeKey: opportunity.runtimeKey,
          groupId: opportunity.groupId,
          scopeKey: opportunity.scopeKey,
          replyIntentId,
          auditKind: decision.policy.auditKind ?? 'dry_run_intent',
          payload: {
            outcome: decision.outcome,
            sourceKind: opportunity.sourceKind,
            deliveryType: deliveryPayload.type,
            text: actionText,
            reason: decision.policy.reason,
          },
        })
        log.info(
          {
            direction: 'outbound',
            actor: 'bot',
            category: opportunity.sourceKind === 'private_message' ? 'private_reply' : 'mention_reply',
            flow: 'action_record_dry_run',
            groupId: opportunity.groupId,
            scopeKey: opportunity.scopeKey,
            replyIntentId,
            sourceKind: opportunity.sourceKind,
            deliveryType: deliveryPayload.type,
            dispatchMode: 'dry_run',
            sideEffect: 'audit_write',
            deliveryResult: 'dry_run',
            textPreview: previewText(actionText),
          },
          '回复已生成（未发送）',
        )
        return { decision, replyRecord, actionRecord, deliveryResult: 'dry_run' }
      }

      if (!decision.policy.shouldDeliver) {
        actionRecord = await actionRecordStore.markDeliveryState(actionRecord.id, 'skipped', actionRecord.resultPayload)
        return { decision, replyRecord, actionRecord, deliveryResult: 'skipped' }
      }

      const actionPayload = buildActionResultPayload({ opportunity, deliveryPayload, text: actionText, replyIntentId })
      actionRecord = await actionRecordStore.markDeliveryState(actionRecord.id, 'sending', actionPayload)
      if (replyRecord) await replyRecordStore?.markSending(replyRecord.id)

      let deliveryResult: ReplyExecutionResult['deliveryResult'] = 'failed'
      const replyToMessageId = getReplyTargetId(deliveryPayload)
      const sendResult = deliveryPayload.type === 'reply_to_message'
        ? replyToMessageId == null
          ? { success: false, attempts: 0 }
          : await sender.replyToMessage({
              groupId: opportunity.groupId,
              replyToMessageId,
              mentionUserId: deliveryPayload.mentionUserId,
              text: actionText,
            })
        : deliveryPayload.type === 'send_private_message'
          ? sender.sendPrivateMessage
            ? await sender.sendPrivateMessage({
                userId: deliveryPayload.userId ?? opportunity.targetUserId ?? opportunity.groupId,
                text: actionText,
              })
            : { success: false, attempts: 0 }
          : await sender.sendMessage({
              groupId: opportunity.groupId,
              text: actionText,
            })

      if (sendResult.success) {
        deliveryResult = 'sent'
        actionRecord = await actionRecordStore.markDeliveryState(actionRecord.id, 'sent', {
          ...actionPayload,
          providerMessageId: sendResult.providerMessageId ?? null,
          attempts: sendResult.attempts,
        })
        if (sendResult.providerMessageId != null) {
          if (replyRecord) await replyRecordStore?.markAcked(replyRecord.id, sendResult.providerMessageId)
        }
        if (replyRecord) await replyRecordStore?.markSent(replyRecord.id)
        log.info(
          {
            direction: 'outbound',
            actor: 'bot',
            category: opportunity.sourceKind === 'private_message' ? 'private_reply_delivery' : 'reply_delivery',
            flow: 'action_record_delivery',
            groupId: opportunity.groupId,
            scopeKey: opportunity.scopeKey,
            replyIntentId,
            actionRecordId: actionRecord.id,
            sourceKind: opportunity.sourceKind,
            deliveryType: deliveryPayload.type,
            providerMessageId: sendResult.providerMessageId,
            attempts: sendResult.attempts,
            dispatchMode: 'live',
            sideEffect: 'napcat_send',
            deliveryResult: 'sent',
            textPreview: previewText(actionText),
          },
          '动作投递成功',
        )
      } else {
        actionRecord = await actionRecordStore.markDeliveryState(actionRecord.id, 'failed', {
          ...actionPayload,
          error: 'send failed',
        })
        if (replyRecord) await replyRecordStore?.markFailed(replyRecord.id)
      }

      if (deliveryResult === 'sent' && replyRecord) {
        await options.onReplyRecordSent?.(replyRecord)
      }
      return { decision, replyRecord, actionRecord, deliveryResult }
    },
  }
}
