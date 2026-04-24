import { createLogger } from '../logger.js'
import { getMessageById } from '../database/messages.js'
import type { Message } from '../generated/prisma/client.js'
import { resolveMessage } from '../media/message-resolver.js'
import { messageSender, type MessageSender } from '../messaging/message-sender.js'
import { generateMentionReply } from '../responder/reply-generator.js'
import type { IncomingMessage } from '../responder/pipeline.js'
import { createReplyAudit, createOrReuseReplyAudit } from '../conversation/reply-audit-store.js'
import { deliverReplyRecord } from '../conversation/reply-record-delivery.js'
import {
  createOrReuseReplyRecord,
  findReplyRecordByReplyIntentId,
  markReplyRecordAcked,
  markReplyRecordFailed,
  markReplyRecordSending,
  markReplyRecordSent,
  type ReplyRecord,
} from '../conversation/reply-record-store.js'
import { createReplyDecisionEngine, type ReplyDecisionEngine } from './reply-decision-engine.js'
import type { ReplyDecision, ReplyExecutionResult, ReplyOpportunity } from './reply-decision-types.js'

type StoredConversationMessage = NonNullable<Awaited<ReturnType<typeof getMessageById>>>

const log = createLogger('REPLY_EXECUTOR')

export interface ReplyExecutorOptions {
  decisionEngine?: ReplyDecisionEngine
  generateReply?: (message: IncomingMessage, opportunity: ReplyOpportunity) => Promise<string | null>
  buildIncomingMessage?: (opportunity: ReplyOpportunity) => Promise<IncomingMessage | null>
  sender?: MessageSender
  replyRecordStore?: {
    findByReplyIntentId: typeof findReplyRecordByReplyIntentId
    createOrReuse: typeof createOrReuseReplyRecord
    markAcked: typeof markReplyRecordAcked
    markSending: typeof markReplyRecordSending
    markSent: typeof markReplyRecordSent
    markFailed: typeof markReplyRecordFailed
  }
  replyAuditStore?: {
    create?: typeof createReplyAudit
    createOrReuse?: typeof createOrReuseReplyAudit
  }
  deliver?: typeof deliverReplyRecord
  onReplyRecordSent?: (record: ReplyRecord) => Promise<void>
}

export interface ReplyExecutor {
  execute(opportunity: ReplyOpportunity): Promise<ReplyExecutionResult>
}


async function defaultBuildIncomingMessage(opportunity: ReplyOpportunity): Promise<IncomingMessage | null> {
  const stored = (await getMessageById(opportunity.groupId, opportunity.incorporatedMessageId)) as StoredConversationMessage | null
  if (!stored) return null
  const segments = await resolveMessage(stored as Message, { timeoutMs: 0 })
  return {
    groupId: Number(stored.groupId),
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

export function createReplyExecutor(options: ReplyExecutorOptions = {}): ReplyExecutor {
  const decisionEngine = options.decisionEngine ?? createReplyDecisionEngine()
  const generateReply = options.generateReply ?? ((message: IncomingMessage) => generateMentionReply(message))
  const sender = options.sender ?? messageSender
  const replyRecordStore = options.replyRecordStore ?? {
    findByReplyIntentId: findReplyRecordByReplyIntentId,
    createOrReuse: createOrReuseReplyRecord,
    markAcked: markReplyRecordAcked,
    markSending: markReplyRecordSending,
    markSent: markReplyRecordSent,
    markFailed: markReplyRecordFailed,
  }
  const configuredReplyAuditStore = options.replyAuditStore
  const replyAuditStore = {
    create: configuredReplyAuditStore?.create ?? createReplyAudit,
    createOrReuse: configuredReplyAuditStore?.createOrReuse ?? configuredReplyAuditStore?.create ?? createOrReuseReplyAudit,
  }
  const deliver = options.deliver ?? deliverReplyRecord

  return {
    async execute(opportunity) {
      const decision = decisionEngine.decide(opportunity)

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
      const existingRecord =
        (await replyRecordStore.findByReplyIntentId(opportunity.runtimeKey, replyIntentId)) ??
        (legacyReplyIntentId && legacyReplyIntentId !== replyIntentId
          ? await replyRecordStore.findByReplyIntentId(opportunity.runtimeKey, legacyReplyIntentId)
          : null)

      let reply = existingRecord?.text ?? null
      if (!reply && decision.policy.shouldGenerate) {
        const message = await (options.buildIncomingMessage ?? defaultBuildIncomingMessage)(opportunity)
        if (!message) {
          log.warn({ opportunityId: opportunity.opportunityId }, 'reply opportunity missing incoming message; skipping')
          return { decision, deliveryResult: 'skipped' }
        }
        reply = await generateReply(message, opportunity)
      }

      if (!reply) {
        log.warn({ opportunityId: opportunity.opportunityId }, 'reply opportunity generated no formal reply')
        return { decision, deliveryResult: 'skipped' }
      }

      const shouldDryRun = sender.isReplyDryRunEnabled?.() ?? false
      const replyRecord = await replyRecordStore.createOrReuse({
        runtimeKey: opportunity.runtimeKey,
        groupId: opportunity.groupId,
        scopeKey: opportunity.scopeKey,
        replyIntentId: existingRecord?.replyIntentId ?? replyIntentId,
        sourceKind: opportunity.sourceKind,
        triggerMessageRowId: opportunity.triggerMessageRowId,
        incorporatedMessageRowId: opportunity.incorporatedMessageRowId,
        deliveryPayload: {
          type: 'reply_to_message',
          replyToMessageId: opportunity.triggerMessageId,
          mentionUserId: opportunity.triggerSenderId,
        },
        text: reply,
        executionState: shouldDryRun ? 'dry_run' : 'pending',
      })

      if (replyRecord.executionState === 'sent') {
        await options.onReplyRecordSent?.(replyRecord)
        return { decision, replyRecord, deliveryResult: 'sent' }
      }

      if (replyRecord.executionState === 'dry_run') {
        await replyAuditStore.createOrReuse({
          replyRecordId: replyRecord.id,
          opportunityId: opportunity.opportunityId,
          runtimeKey: replyRecord.runtimeKey,
          groupId: replyRecord.groupId,
          scopeKey: replyRecord.scopeKey,
          replyIntentId: replyRecord.replyIntentId,
          auditKind: decision.policy.auditKind ?? 'dry_run_intent',
          payload: {
            outcome: decision.outcome,
            sourceKind: replyRecord.sourceKind,
            deliveryType: replyRecord.deliveryPayload.type,
            text: replyRecord.text,
            reason: decision.policy.reason,
          },
        })
        return { decision, replyRecord, deliveryResult: 'dry_run' }
      }

      const deliveryResult = decision.policy.shouldDeliver
        ? await deliver(replyRecord, { sender, replyRecordStore, replyAuditStore })
        : 'skipped'
      if (deliveryResult === 'sent') {
        await options.onReplyRecordSent?.(replyRecord)
      }
      return { decision, replyRecord, deliveryResult }
    },
  }
}
