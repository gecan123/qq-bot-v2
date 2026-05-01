import { createLogger } from '../logger.js'
import { getMessageById, getMessageBySceneMessageId } from '../database/messages.js'
import type { Message } from '../generated/prisma/client.js'
import { resolveMessage } from '../media/message-resolver.js'
import { messageSender, type MessageSender } from '../messaging/message-sender.js'
import { generateMentionReply } from '../responder/reply-generator.js'
import type { IncomingMessage } from '../responder/pipeline.js'
import { createReplyAudit, createOrReuseReplyAudit } from '../conversation/reply-audit-store.js'
import type { ReplyDeliveryPayload, ReplyRecord } from '../conversation/reply-record-store.js'
import { createReplyDecisionEngine, type ReplyDecisionEngine } from './reply-decision-engine.js'
import type { ReplyDecision, ReplyExecutionResult, ReplyOpportunity } from './reply-decision-types.js'
import { previewText, type BusinessLogDispatchMode, type BusinessLogSideEffect } from '../utils/business-log.js'
import { createOrReuseActionIntent, createOrReuseActionRecord, markActionRecordDeliveryState } from './action-record-store.js'
import { classifyAction, deliveryStateFromEffectMode } from './action-barrier.js'
import type { ExecutableActionIntent, ActionExecutorResult } from './action-executor.js'

type StoredConversationMessage = NonNullable<Awaited<ReturnType<typeof getMessageById>>>

const log = createLogger('REPLY_EXECUTOR')

export interface ReplyExecutorOptions {
  decisionEngine?: ReplyDecisionEngine
  generateReply?: (message: IncomingMessage, opportunity: ReplyOpportunity) => Promise<string | null>
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
  actionExecutor?: {
    execute(intent: ExecutableActionIntent): Promise<ActionExecutorResult>
  }
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
    messageRowId: stored.id,
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

  return {
    type: 'reply_to_message',
    groupId: decision.opportunity.groupId,
    messageId: decision.opportunity.triggerMessageId,
    replyToMessageId: decision.opportunity.triggerMessageId,
    mentionUserId: decision.opportunity.triggerSenderId,
  }
}

function isSupportedSendableGeneration(decision: ReplyDecision): boolean {
  return (
    (decision.deliveryMode === 'reply_to_message' && decision.opportunity.sourceKind === 'mention') ||
    (decision.deliveryMode === 'send_private_message' && decision.opportunity.sourceKind === 'private_message')
  )
}

function getDecisionDispatchMode(decision: ReplyDecision): BusinessLogDispatchMode {
  if (decision.policy.shouldCreateReplyRecord) return decision.dryRun ? 'dry_run' : 'live'
  return 'audit_only'
}

function getDecisionSideEffect(decision: ReplyDecision): BusinessLogSideEffect {
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

function getReplyTargetId(payload: ReplyDeliveryPayload): number | null {
  if (payload.type !== 'reply_to_message') return null
  const target = payload.replyToMessageId ?? payload.messageId
  return typeof target === 'number' && Number.isSafeInteger(target) ? target : null
}

function toReplyDeliveryResult(state: string): ReplyExecutionResult['deliveryResult'] {
  if (state === 'sent' || state === 'acked') return 'sent'
  if (state === 'dry_run') return 'dry_run'
  if (state === 'failed') return 'failed'
  return 'skipped'
}

export function createReplyExecutor(options: ReplyExecutorOptions = {}): ReplyExecutor {
  const decisionEngine = options.decisionEngine ?? createReplyDecisionEngine()
  const generateMentionReplyFn = options.generateReply ?? ((message: IncomingMessage, opportunity: ReplyOpportunity) => generateMentionReply(message, opportunity))
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
          category: opportunity.sourceKind === 'private_message' ? 'private_reply' : 'mention_reply',
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
          reason: decision.policy.reason,
        },
        '回复决策完成',
      )

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

      let reply: string | null = null
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
        reply = await generateMentionReplyFn(message, opportunity)
      }

      if (!reply) {
        log.warn({ opportunityId: opportunity.opportunityId }, 'reply opportunity generated no formal reply')
        return { decision, deliveryResult: 'skipped' }
      }

      const deliveryPayload = buildDeliveryPayload(decision)
      const actionType = deliveryPayload.type === 'reply_to_message' ? 'send_group_reply' : 'send_private_message'
      const shouldDryRun = opportunity.dryRun
      const actionPayload = buildActionResultPayload({ opportunity, deliveryPayload, text: reply, replyIntentId })
      const actionIntent = await actionRecordStore.createOrReuseIntent({
        id: `${opportunity.opportunityId}:intent:${actionType}`,
        opportunityId: opportunity.opportunityId,
        decisionId: opportunity.decisionId,
        actionType,
        targetSceneId: opportunity.sceneId,
        payload: actionPayload,
        dryRun: shouldDryRun,
        riskLevel: classifyAction({ actionType }),
        status: shouldDryRun ? 'skipped' : decision.policy.shouldDeliver ? 'approved' : 'rejected',
        idempotencyKey: `${opportunity.opportunityId}:${actionType}`,
      })
      const replyRecord = replyRecordStore
        ? await replyRecordStore.createOrReuse({
            runtimeKey: opportunity.runtimeKey,
            groupId: opportunity.groupId,
            scopeKey: opportunity.scopeKey,
            replyIntentId,
            sourceKind: opportunity.sourceKind,
            triggerMessageRowId: opportunity.triggerMessageRowId,
            incorporatedMessageRowId: opportunity.incorporatedMessageRowId,
            deliveryPayload,
            text: reply,
            executionState: shouldDryRun ? 'dry_run' : 'pending',
          })
        : undefined

      if (options.actionExecutor) {
        const execResult = await options.actionExecutor.execute(actionIntent)
        const deliveryResult = toReplyDeliveryResult(execResult.deliveryResult)

        if (replyRecord) {
          if (deliveryResult === 'sent') {
            await replyRecordStore?.markSent(replyRecord.id)
          } else if (deliveryResult === 'failed') {
            await replyRecordStore?.markFailed(replyRecord.id)
          }
        }

        if (deliveryResult === 'dry_run') {
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
              text: reply,
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
              textPreview: previewText(reply),
            },
            '回复已生成（未发送）',
          )
        }

        if (deliveryResult === 'sent' && replyRecord) {
          await options.onReplyRecordSent?.(replyRecord)
          log.info(
            {
              direction: 'outbound',
              actor: 'bot',
              category: opportunity.sourceKind === 'private_message' ? 'private_reply_delivery' : 'reply_delivery',
              flow: 'action_record_delivery',
              groupId: opportunity.groupId,
              scopeKey: opportunity.scopeKey,
              replyIntentId,
              actionRecordId: execResult.actionRecord.id,
              sourceKind: opportunity.sourceKind,
              deliveryType: deliveryPayload.type,
              dispatchMode: 'live',
              sideEffect: 'napcat_send',
              deliveryResult,
              textPreview: previewText(reply),
            },
            '动作投递成功',
          )
        }

        return { decision, replyRecord, actionRecord: execResult.actionRecord, deliveryResult }
      }

      // fallback: no actionExecutor, create record and send directly via sender
      let actionRecord = await actionRecordStore.createOrReuseRecord({
        id: `${actionIntent.id}:record`,
        actionIntentId: actionIntent.id,
        actionType,
        targetSceneId: opportunity.sceneId,
        deliveryState: deliveryStateFromEffectMode(shouldDryRun ? 'dry_run' : decision.policy.shouldDeliver ? 'live' : 'suppressed'),
        idempotencyKey: actionIntent.idempotencyKey,
        resultPayload: actionPayload,
      })

      if (actionRecord.deliveryState === 'sent' || actionRecord.deliveryState === 'acked') {
        if (replyRecord) {
          await replyRecordStore?.markSent(replyRecord.id)
          await options.onReplyRecordSent?.(replyRecord)
        }
        return { decision, replyRecord, actionRecord, deliveryResult: 'sent' }
      }

      if (actionRecord.deliveryState === 'dry_run' || shouldDryRun || !decision.policy.shouldDeliver) {
        return { decision, replyRecord, actionRecord, deliveryResult: shouldDryRun ? 'dry_run' : 'skipped' }
      }

      if (!sender) {
        return { decision, replyRecord, actionRecord, deliveryResult: 'skipped' }
      }

      actionRecord = await actionRecordStore.markDeliveryState(actionRecord.id, 'sending', actionPayload)
      if (replyRecord) await replyRecordStore?.markSending(replyRecord.id)

      const replyToMessageId = getReplyTargetId(deliveryPayload)
      const sendResult = deliveryPayload.type === 'reply_to_message'
        ? replyToMessageId == null
          ? { success: false, attempts: 0 }
          : await sender.replyToMessage({
              groupId: opportunity.groupId,
              replyToMessageId,
              mentionUserId: deliveryPayload.mentionUserId,
              text: reply,
            })
        : deliveryPayload.type === 'send_private_message' && sender.sendPrivateMessage
          ? await sender.sendPrivateMessage({
              userId: deliveryPayload.userId ?? opportunity.targetUserId ?? opportunity.groupId,
              text: reply,
            })
          : { success: false, attempts: 0 }

      let deliveryResult: ReplyExecutionResult['deliveryResult'] = 'failed'
      if (sendResult.success) {
        deliveryResult = 'sent'
        actionRecord = await actionRecordStore.markDeliveryState(actionRecord.id, 'sent', {
          ...actionPayload,
          providerMessageId: sendResult.providerMessageId ?? null,
          attempts: sendResult.attempts,
        })
        if (replyRecord) {
          if (sendResult.providerMessageId != null) await replyRecordStore?.markAcked(replyRecord.id, sendResult.providerMessageId)
          await replyRecordStore?.markSent(replyRecord.id)
          await options.onReplyRecordSent?.(replyRecord)
        }
      } else {
        actionRecord = await actionRecordStore.markDeliveryState(actionRecord.id, 'failed', { ...actionPayload, error: 'send failed' })
        if (replyRecord) await replyRecordStore?.markFailed(replyRecord.id)
      }
      return { decision, replyRecord, actionRecord, deliveryResult }
    },
  }
}
