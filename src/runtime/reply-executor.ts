import { createLogger } from '../logger.js'
import { getMessageById } from '../database/messages.js'
import type { Message } from '../generated/prisma/client.js'
import { resolveMessage } from '../media/message-resolver.js'
import { messageSender, type MessageSender } from '../messaging/message-sender.js'
import { generateMentionReply, generateProactiveCandidateReply } from '../responder/reply-generator.js'
import type { ProactiveCandidateReplyResult } from '../responder/reply-generator.js'
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
  type ReplyDeliveryPayload,
  type ReplyRecord,
} from '../conversation/reply-record-store.js'
import { createReplyDecisionEngine, type ReplyDecisionEngine } from './reply-decision-engine.js'
import type { ReplyDecision, ReplyExecutionResult, ReplyOpportunity } from './reply-decision-types.js'
import type { ProactiveCandidateArtifact, ProactiveCandidateStatus } from './types.js'
import { previewText } from '../utils/business-log.js'

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
  proactiveCandidateStore?: {
    createOrReuse: (artifact: ProactiveCandidateArtifact) => Promise<void>
  }
  onProactiveGenerationAttempt?: (opportunity: ReplyOpportunity) => Promise<void>
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

function buildDeliveryPayload(decision: ReplyDecision): ReplyDeliveryPayload {
  if (decision.deliveryMode === 'send_message') {
    return { type: 'send_message' }
  }

  return {
    type: 'reply_to_message',
    replyToMessageId: decision.opportunity.triggerMessageId,
    mentionUserId: decision.opportunity.triggerSenderId,
  }
}

function isDryRunEnabledForPayload(sender: MessageSender, payload: ReplyDeliveryPayload): boolean {
  return payload.type === 'send_message'
    ? (sender.isSendDryRunEnabled?.() ?? false)
    : (sender.isReplyDryRunEnabled?.() ?? false)
}

function buildProactiveCandidateArtifact(input: {
  decision: ReplyDecision
  reply: string | null
  termination: string
  status: ProactiveCandidateStatus
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
    candidateText: input.status === 'candidate_generated' ? input.reply ?? undefined : undefined,
    termination: input.termination,
    status: input.status,
  }
}

function isSupportedSendableGeneration(decision: ReplyDecision): boolean {
  return decision.deliveryMode === 'reply_to_message' && decision.opportunity.sourceKind === 'mention'
}

export function createReplyExecutor(options: ReplyExecutorOptions = {}): ReplyExecutor {
  const decisionEngine = options.decisionEngine ?? createReplyDecisionEngine()
  const generateMentionReplyFn = options.generateReply ?? ((message: IncomingMessage) => generateMentionReply(message))
  const generateProactiveCandidateReplyFn =
    options.generateProactiveCandidateReply ??
    ((message: IncomingMessage) => generateProactiveCandidateReply(message))
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
      log.info(
        {
          direction: 'internal',
          actor: 'system',
          category: opportunity.sourceKind === 'mention' ? 'mention_reply' : 'ambient_candidate',
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
          replyProbability: decision.opportunity.replyProbability,
          gateReasons: decision.policy.gateReasons ?? [],
          reason: decision.policy.reason,
        },
        '回复决策完成',
      )

      if (decision.policy.artifactKind === 'proactive_candidate') {
        let reply: string | null = null
        let termination = 'policy_suppressed'
        let status: ProactiveCandidateStatus = 'suppressed'

        if (decision.policy.shouldGenerate) {
          const message = await (options.buildIncomingMessage ?? defaultBuildIncomingMessage)(decision.opportunity)
          if (!message) {
            termination = 'missing_incoming_message'
            status = 'no_candidate'
          } else {
            await options.onProactiveGenerationAttempt?.(decision.opportunity)
            const generated = normalizeGeneratedReply(await generateProactiveCandidateReplyFn(message, decision.opportunity))
            reply = generated.text
            termination = generated.termination
            if (reply?.trim()) {
              status = 'candidate_generated'
            } else {
              status = 'no_candidate'
            }
          }
        }

        const artifact = buildProactiveCandidateArtifact({
          decision,
          reply,
          termination,
          status,
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
            gateReasons: artifact.gateReasons,
            triggerMessageRowId: artifact.triggerMessageRowId,
            incorporatedMessageRowId: artifact.incorporatedMessageRowId,
            textPreview: previewText(artifact.candidateText),
          },
          'Bot 主动候选已生成',
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
      const replyRecord = await replyRecordStore.createOrReuse({
        runtimeKey: opportunity.runtimeKey,
        groupId: opportunity.groupId,
        scopeKey: opportunity.scopeKey,
        replyIntentId: existingRecord?.replyIntentId ?? replyIntentId,
        sourceKind: opportunity.sourceKind,
        triggerMessageRowId: opportunity.triggerMessageRowId,
        incorporatedMessageRowId: opportunity.incorporatedMessageRowId,
        deliveryPayload,
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
        log.info(
          {
            direction: 'outbound',
            actor: 'bot',
            category: 'mention_reply',
            flow: 'reply_record_dry_run',
            groupId: replyRecord.groupId,
            scopeKey: replyRecord.scopeKey,
            replyIntentId: replyRecord.replyIntentId,
            sourceKind: replyRecord.sourceKind,
            deliveryType: replyRecord.deliveryPayload.type,
            textPreview: previewText(replyRecord.text),
          },
          'Bot 回复已生成（dry run）',
        )
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
