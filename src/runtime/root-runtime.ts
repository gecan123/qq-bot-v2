import type { ParsedSegment } from '../types/message-segments.js'
import type { BusinessLogIngestSource } from '../utils/business-log.js'
import { prisma } from '../database/client.js'
import {
  buildMessageReferencePayload,
  createOrReuseDecision,
  createOrReuseActionIntent,
  createOrReuseActionRecord,
  createOrReuseOpportunity,
  createOrReuseRuntimeEvent,
  getAgentRuntimeSnapshot,
  getOrCreateMainAgentRuntime,
  getOrCreateScene,
  listPendingArbiterOpportunities,
  markOpportunityStatus,
  upsertAgentRuntimeSnapshot,
} from './agent-runtime-store.js'
import {
  MAIN_AGENT_ID,
  makeQqGroupSceneId,
  makeQqPrivateSceneId,
  type ActionType,
  type Opportunity,
  type ReferencePayload,
  type SceneId,
} from './agent-runtime-types.js'
import type { ConversationWorkerResult, GroupConversationBatch } from '../conversation/types.js'
import type { ReplyExecutionResult, ReplyOpportunity } from './reply-decision-types.js'
import {
  buildBarrierOutput,
  DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG,
  decideExecution,
  deliveryStateFromEffectMode,
  verdictFromEffectMode,
} from './action-barrier.js'
import {
  acceptArbiterProposal,
  buildArbiterCandidates,
  chooseDeterministicCandidate,
  type ArbiterCandidate,
  type ArbiterProposal,
} from './arbiter.js'

export type RuntimeEventKind = 'group_message' | 'private_message' | 'scheduler_tick' | 'manual_wake'

export interface PersistedGroupMessageIngress {
  [key: string]: unknown
  sceneKind?: 'qq_group'
  messageRowId: number
  messageId: number
  groupId: number
  senderId: number
  segments: ParsedSegment[]
}

export interface PersistedPrivateMessageIngress {
  [key: string]: unknown
  sceneKind: 'qq_private'
  sceneExternalId?: string
  messageRowId: number
  messageId: number
  userId: number
  senderId: number
  segments: ParsedSegment[]
}

export type PersistedSocialMessageIngress = PersistedGroupMessageIngress | PersistedPrivateMessageIngress

export interface RuntimeEvent {
  [key: string]: unknown
  eventKind?: RuntimeEventKind
  createdAt: Date
  message?: PersistedSocialMessageIngress
}

export interface PersistedGroupMessageIngressOptions {
  executeDecisions?: boolean
  ingestSource?: BusinessLogIngestSource
}

export interface RuntimeEventOptions extends PersistedGroupMessageIngressOptions {}

export interface RootRuntimeManager {
  restore(groups: number[]): Promise<{ restoredCount: number }>
  emitRuntimeEvent(event: RuntimeEvent, options?: RuntimeEventOptions): Promise<void>
  ingestGroupMessage(input: PersistedGroupMessageIngress, options?: PersistedGroupMessageIngressOptions): Promise<void>
  ingestPrivateMessage?(input: PersistedPrivateMessageIngress, options?: PersistedGroupMessageIngressOptions): Promise<void>
  getSnapshot(group: number): { lastObservedMessageRowId?: number; [key: string]: unknown } | null
  primeGroupCursor(input: Record<string, unknown>): Promise<void>
  requeuePendingPassiveMentions(groups?: number[]): number
  markPassiveReplyDelivered(input: Record<string, unknown>): Promise<void>
  dispatchPassiveMentionIfMentioned(input: Record<string, unknown>): boolean
  enqueuePassiveMention(event: unknown): void
  startPassiveExecution(): void
  stopPassiveExecution(): void
}

export interface RootRuntimeManagerOptions {
  [key: string]: unknown
  selfNumber: number
  now?: () => Date
  passiveWorker?: (batch: GroupConversationBatch) => Promise<ConversationWorkerResult | void> | ConversationWorkerResult | void
  ambientExecutor?: { execute(opportunity: ReplyOpportunity): Promise<ReplyExecutionResult> }
  ambientReplyBaseProbability?: number
  replyDryRunEnabled?: boolean
  arbiter?: { choose(candidates: readonly ArbiterCandidate[]): ArbiterProposal | Promise<ArbiterProposal> }
}

const snapshots = new Map<SceneId, Record<string, unknown>>()

function readSceneCursors(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {}
  const raw = (value as { sceneCursors?: unknown }).sceneCursors
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [sceneId, cursor] of Object.entries(raw)) {
    if (typeof cursor === 'number' && Number.isSafeInteger(cursor)) out[sceneId] = cursor
  }
  return out
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value)
}

function asDate(value: unknown, fallback: Date): Date {
  return value instanceof Date ? value : fallback
}

function asMessage(input: Record<string, unknown>): PersistedSocialMessageIngress | null {
  const message = input.message
  if (message && typeof message === 'object') return message as PersistedSocialMessageIngress
  return null
}

function isMentionedSelf(segments: ParsedSegment[], selfNumber: number): boolean {
  return segments.some((segment) => segment.type === 'at' && segment.targetId === String(selfNumber))
}

function buildReferencePayload(input: {
  messageRow: number
  message: number
  source: string
  idempotencyKey: string
}): ReferencePayload {
  return buildMessageReferencePayload({
    messageRowId: input.messageRow,
    messageId: input.message,
    ingestSource: input.source,
    source: 'messages',
    idempotencyKey: input.idempotencyKey,
  }) as ReferencePayload
}

function buildBarrierPayload(input: {
  sceneId: SceneId
  targetUserId?: number
  messageRowId: number
  messageId: number
  opportunityType: string
  actionType: string
  dryRun: boolean
}) {
  return {
    sourceRefs: {
      messageRowId: input.messageRowId,
      messageId: input.messageId,
      source: 'messages',
    },
    target: {
      sceneId: input.sceneId,
      userId: input.targetUserId,
    },
    opportunityType: input.opportunityType,
    actionType: input.actionType,
    dryRun: input.dryRun,
  }
}

function buildActionIntentPayload(input: {
  sceneId: SceneId
  targetUserId?: number
  messageRowId: number
  messageId: number
  decisionId: string
  actionType: string
  dryRun: boolean
  generatedTextStatus?: 'not_generated' | 'deferred'
}) {
  return {
    sourceRefs: {
      messageRowId: input.messageRowId,
      messageId: input.messageId,
      source: 'messages',
    },
    target: {
      sceneId: input.sceneId,
      userId: input.targetUserId,
    },
    decisionId: input.decisionId,
    proposedEffect: {
      type: input.actionType,
      generatedTextStatus: input.generatedTextStatus ?? 'not_generated',
    },
    dryRun: input.dryRun,
  }
}

function isPrivateMessageIngress(input: PersistedSocialMessageIngress): input is PersistedPrivateMessageIngress {
  return input.sceneKind === 'qq_private'
}

function isPrivateOpportunity(opportunity: Opportunity): boolean {
  return opportunity.opportunityType === 'reply_private_message' || opportunity.sceneId.startsWith('qq_private:')
}

function isMentionOpportunity(opportunity: Opportunity): boolean {
  return opportunity.opportunityType === 'reply_to_mention'
}

function actionTypeForOpportunity(opportunity: Opportunity): ActionType {
  if (isPrivateOpportunity(opportunity)) return 'send_private_message'
  if (isMentionOpportunity(opportunity)) return 'reply_to_message'
  return 'send_group_message'
}

interface OpportunityExecutionContext {
  sceneId: SceneId
  group: number
  targetUserId?: number
  messageRow: number
  message: number
  senderId: number
  createdAt: Date
}

type OpportunityTerminalStatus = 'succeeded' | 'failed' | 'skipped'

function opportunityStatusFromDeliveryResult(
  deliveryResult: ReplyExecutionResult['deliveryResult'] | undefined,
): OpportunityTerminalStatus {
  switch (deliveryResult) {
    case 'sent':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'dry_run':
    case 'skipped':
    default:
      return 'skipped'
  }
}

function opportunityStatusFromPassiveResult(result: ConversationWorkerResult | void): OpportunityTerminalStatus {
  const deliveryResults = result?.deliveryResults ?? []
  if (deliveryResults.includes('failed')) return 'failed'
  if (deliveryResults.includes('sent')) return 'succeeded'
  return 'skipped'
}

function buildAmbientReplyOpportunity(input: {
  sceneId: SceneId
  groupId: number
  messageRowId: number
  messageId: number
  senderId: number
  opportunityId: string
  decisionId: string
  replyProbability: number
  createdAt: Date
}): ReplyOpportunity {
  return {
    opportunityId: input.opportunityId,
    decisionId: input.decisionId,
    runtimeKey: MAIN_AGENT_ID,
    groupId: input.groupId,
    sceneId: input.sceneId,
    scopeKey: input.sceneId,
    sourceKind: 'ambient_message',
    cueStrength: 'weak',
    mustReplyOverride: false,
    replyProbability: input.replyProbability,
    triggerMessageRowId: input.messageRowId,
    triggerMessageId: input.messageId,
    triggerSenderId: input.senderId,
    incorporatedMessageRowId: input.messageRowId,
    incorporatedMessageId: input.messageId,
    deliveryMode: input.replyProbability > 0 ? 'send_message' : 'audit_only',
    dryRun: true,
    reason: 'ordinary group message is proactive candidate dry-run only before Phase 10',
    createdAt: input.createdAt,
  }
}

function buildPrivateReplyOpportunity(input: {
  sceneId: SceneId
  userId: number
  messageRowId: number
  messageId: number
  senderId: number
  opportunityId: string
  decisionId: string
  dryRun: boolean
  createdAt: Date
}): ReplyOpportunity {
  return {
    opportunityId: input.opportunityId,
    decisionId: input.decisionId,
    runtimeKey: MAIN_AGENT_ID,
    groupId: input.userId,
    targetUserId: input.userId,
    sceneId: input.sceneId,
    scopeKey: input.sceneId,
    sourceKind: 'private_message',
    cueStrength: 'strong',
    mustReplyOverride: true,
    replyProbability: 1,
    anchorMessageRowId: input.messageRowId,
    triggerMessageRowId: input.messageRowId,
    triggerMessageId: input.messageId,
    triggerSenderId: input.senderId,
    incorporatedMessageRowId: input.messageRowId,
    incorporatedMessageId: input.messageId,
    deliveryMode: 'send_private_message',
    dryRun: input.dryRun,
    reason: 'direct QQ private message is a private_reply opportunity',
    createdAt: input.createdAt,
  }
}

export function createRootRuntimeManager(options: RootRuntimeManagerOptions): RootRuntimeManager {
  const now = options.now ?? (() => new Date())

  async function chooseOpportunity(opportunities: Opportunity[]) {
    const candidates = buildArbiterCandidates(opportunities)
    const proposal = options.arbiter
      ? await options.arbiter.choose(candidates)
      : chooseDeterministicCandidate(candidates)
    return acceptArbiterProposal(candidates, proposal)
  }

  async function hydrateOpportunityContext(opportunity: Opportunity): Promise<OpportunityExecutionContext | null> {
    const messageRow = asNumber(opportunity.payload.messageRowId)
    if (!Number.isSafeInteger(messageRow)) return null

    const row = await prisma.message.findUnique({ where: { id: messageRow } })
    if (!row) return null

    const privateOpportunity = isPrivateOpportunity(opportunity)
    const group = privateOpportunity ? Number(row.senderId) : Number(row.groupId)
    return {
      sceneId: opportunity.sceneId,
      group,
      targetUserId: privateOpportunity ? group : undefined,
      messageRow: row.id,
      message: Number(row.messageId),
      senderId: Number(row.senderId),
      createdAt: row.createdAt,
    }
  }

  async function createDecisionForOpportunity(
    opportunity: Opportunity,
    context: OpportunityExecutionContext,
    runtimeOptions: PersistedGroupMessageIngressOptions,
  ) {
    const privateOpportunity = isPrivateOpportunity(opportunity)
    const mentionOpportunity = isMentionOpportunity(opportunity)
    const actionType = actionTypeForOpportunity(opportunity)
    const replyDryRunEnabled = options.replyDryRunEnabled === true
    const shouldExecuteMention = mentionOpportunity && runtimeOptions.executeDecisions !== false && Boolean(options.passiveWorker)
    const shouldExecutePrivate = privateOpportunity && runtimeOptions.executeDecisions !== false && Boolean(options.ambientExecutor)
    const barrierExecutorAvailable = privateOpportunity
      ? shouldExecutePrivate
      : mentionOpportunity
        ? shouldExecuteMention
        : runtimeOptions.executeDecisions !== false
    const barrierVerdict = decideExecution(
      {
        actionType,
        sourceKind: privateOpportunity ? 'private_message' : mentionOpportunity ? 'mention' : 'ambient_message',
        targetSceneId: context.sceneId,
        dryRunRequested: replyDryRunEnabled || (!privateOpportunity && !mentionOpportunity),
        executorAvailable: barrierExecutorAvailable,
      },
      {},
      {
        ...DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG,
        privateReplyDryRun: replyDryRunEnabled,
        anchoredGroupReplyDryRun: replyDryRunEnabled,
      },
    )
    const barrierOutput = buildBarrierOutput(barrierVerdict)
    const dryRun = barrierVerdict.effectMode === 'dry_run'
    const allowedToSend = barrierVerdict.effectMode === 'live'
    const decision = await createOrReuseDecision({
      opportunityId: opportunity.id,
      idempotencyKey: `${opportunity.id}:policy`,
      policyVersion: barrierVerdict.policyVersion,
      verdict: verdictFromEffectMode(barrierVerdict.effectMode),
      actionType,
      riskLevel: barrierVerdict.riskBand,
      reason: replyDryRunEnabled && (shouldExecuteMention || shouldExecutePrivate)
        ? 'reply dry-run is enabled; generation may run but external send is disabled'
        : shouldExecutePrivate
          ? 'direct QQ private message may execute private reply'
          : privateOpportunity
            ? 'private reply decisions disabled or reply executor unavailable'
            : shouldExecuteMention
              ? 'direct @self mention may execute anchored group reply'
              : mentionOpportunity
                ? 'mention reply decisions disabled or passive worker unavailable'
                : 'ordinary group proactive is dry-run before Phase 10',
      barrierInput: buildBarrierPayload({
        sceneId: context.sceneId,
        targetUserId: context.targetUserId,
        messageRowId: context.messageRow,
        messageId: context.message,
        opportunityType: opportunity.opportunityType,
        actionType,
        dryRun,
      }),
      barrierOutput: {
        ...barrierOutput,
        allowedToSend,
        dryRun,
        dispatchMode: barrierVerdict.effectMode,
        sideEffect: allowedToSend ? 'napcat_send' : dryRun ? 'audit_write' : 'none',
        reason: replyDryRunEnabled && (shouldExecuteMention || shouldExecutePrivate)
          ? 'reply dry-run is enabled; external send is disabled'
          : shouldExecutePrivate
            ? 'private reply is allowed'
            : privateOpportunity
              ? 'snapshot-only private message cannot send'
              : shouldExecuteMention
                ? 'anchored mention reply is allowed'
                : mentionOpportunity
                  ? 'snapshot-only mention cannot send'
                  : 'ordinary group proactive send is disabled before Phase 10',
      },
    })
    return { decision, barrierVerdict, barrierOutput, dryRun, actionType }
  }

  async function recordSkippedAction(input: {
    opportunity: Opportunity
    context: OpportunityExecutionContext
    decisionId: string
    actionType: ActionType
    dryRun: boolean
    riskLevel: ReturnType<typeof decideExecution>['riskBand']
    deliveryState: ReturnType<typeof deliveryStateFromEffectMode>
    barrierOutput: ReturnType<typeof buildBarrierOutput>
    reason: string
  }) {
    const intent = await createOrReuseActionIntent({
      opportunityId: input.opportunity.id,
      decisionId: input.decisionId,
      actionType: input.actionType,
      targetSceneId: input.context.sceneId,
      payload: buildActionIntentPayload({
        sceneId: input.context.sceneId,
        targetUserId: input.context.targetUserId,
        messageRowId: input.context.messageRow,
        messageId: input.context.message,
        decisionId: input.decisionId,
        actionType: input.actionType,
        dryRun: input.dryRun,
      }),
      dryRun: input.dryRun,
      riskLevel: input.riskLevel,
      status: 'skipped',
      idempotencyKey: `${input.opportunity.id}:action`,
    })

    await createOrReuseActionRecord({
      actionIntentId: intent.id,
      actionType: intent.actionType as ActionType,
      targetSceneId: input.context.sceneId,
      deliveryState: input.deliveryState,
      idempotencyKey: intent.idempotencyKey,
      resultPayload: {
        decisionId: input.decisionId,
        barrierVerdict: input.barrierOutput,
        reason: input.reason,
      },
    })
  }

  async function executeSelectedOpportunity(
    opportunity: Opportunity,
    runtimeOptions: PersistedGroupMessageIngressOptions,
    preloadedContext?: OpportunityExecutionContext,
  ) {
    const context = preloadedContext ?? await hydrateOpportunityContext(opportunity)
    if (!context) {
      await markOpportunityStatus(opportunity.id, 'skipped')
      return
    }

    await markOpportunityStatus(opportunity.id, 'executing')
    const privateOpportunity = isPrivateOpportunity(opportunity)
    const mentionOpportunity = isMentionOpportunity(opportunity)
    const { decision, barrierVerdict, barrierOutput, dryRun, actionType } = await createDecisionForOpportunity(
      opportunity,
      context,
      runtimeOptions,
    )
    const canDispatchToExecutor = barrierVerdict.effectMode === 'live' || barrierVerdict.effectMode === 'dry_run'

    try {
      if (canDispatchToExecutor && privateOpportunity && runtimeOptions.executeDecisions !== false && options.ambientExecutor && context.targetUserId != null) {
        const result = await options.ambientExecutor.execute(buildPrivateReplyOpportunity({
          sceneId: context.sceneId,
          userId: context.targetUserId,
          messageRowId: context.messageRow,
          messageId: context.message,
          senderId: context.senderId,
          opportunityId: opportunity.id,
          decisionId: decision.id,
          dryRun: options.replyDryRunEnabled === true,
          createdAt: context.createdAt,
        }))
        await markOpportunityStatus(opportunity.id, opportunityStatusFromDeliveryResult(result.deliveryResult))
        return
      }

      if (canDispatchToExecutor && mentionOpportunity && runtimeOptions.executeDecisions !== false && options.passiveWorker) {
        const result = await options.passiveWorker({
          ['groupId']: context.group,
          events: [{
            ['groupId']: context.group,
            messageId: context.message,
            messageRowId: context.messageRow,
            senderId: context.senderId,
            runtimeOpportunityId: opportunity.id,
            runtimeDecisionId: decision.id,
            runtimeSceneId: context.sceneId,
            createdAt: context.createdAt.getTime(),
          }],
          openedAt: context.createdAt.getTime(),
          closedAt: now().getTime(),
        })
        await markOpportunityStatus(opportunity.id, opportunityStatusFromPassiveResult(result))
        return
      }

      if (canDispatchToExecutor && !privateOpportunity && !mentionOpportunity && runtimeOptions.executeDecisions !== false && options.ambientExecutor) {
        const result = await options.ambientExecutor.execute(buildAmbientReplyOpportunity({
          sceneId: context.sceneId,
          groupId: context.group,
          messageRowId: context.messageRow,
          messageId: context.message,
          senderId: context.senderId,
          opportunityId: opportunity.id,
          decisionId: decision.id,
          replyProbability: typeof options.ambientReplyBaseProbability === 'number' ? options.ambientReplyBaseProbability : 0.02,
          createdAt: context.createdAt,
        }))
        await markOpportunityStatus(opportunity.id, opportunityStatusFromDeliveryResult(result.deliveryResult))
        return
      }
    } catch (error) {
      await markOpportunityStatus(opportunity.id, 'failed')
      throw error
    }

    await recordSkippedAction({
      opportunity,
      context,
      decisionId: decision.id,
      actionType,
      dryRun,
      riskLevel: barrierVerdict.riskBand,
      deliveryState: deliveryStateFromEffectMode(barrierVerdict.effectMode),
      barrierOutput,
      reason: privateOpportunity
        ? 'private reply decisions disabled'
        : mentionOpportunity
          ? 'mention reply decisions disabled'
          : 'ordinary group proactive dry-run only before Phase 10',
    })
    await markOpportunityStatus(opportunity.id, 'skipped')
  }

  async function arbitrateAndExecute(
    opportunities: Opportunity[],
    runtimeOptions: PersistedGroupMessageIngressOptions,
    contexts: Map<string, OpportunityExecutionContext> = new Map(),
  ) {
    const choice = await chooseOpportunity(opportunities)
    if (choice.kind === 'rest') return

    const opportunity = opportunities.find((candidate) => candidate.id === choice.opportunityId)
    if (!opportunity) return
    await executeSelectedOpportunity(opportunity, runtimeOptions, contexts.get(opportunity.id))
  }

  async function drainArbiterQueue(runtimeOptions: PersistedGroupMessageIngressOptions = {}) {
    if (runtimeOptions.executeDecisions === false) return
    const opportunities = await listPendingArbiterOpportunities({ limit: 50 })
    await arbitrateAndExecute(opportunities, runtimeOptions)
  }

  async function materializeMessage(input: PersistedSocialMessageIngress, runtimeOptions: PersistedGroupMessageIngressOptions = {}) {
    const isPrivate = isPrivateMessageIngress(input)
    const group = isPrivate ? asNumber(input.userId) : asNumber(input['groupId'])
    const targetUserId = isPrivate ? asNumber(input.userId) : undefined
    const messageRow = asNumber(input['messageRowId'])
    const message = asNumber(input['messageId'])
    const createdAt = asDate(input['createdAt'], now())
    const source = runtimeOptions.ingestSource ?? 'realtime'
    const sceneId = isPrivate
      ? makeQqPrivateSceneId(input.sceneExternalId ?? targetUserId ?? group)
      : makeQqGroupSceneId(group)
    const idempotencyKey = `message:${messageRow}`
    const referencePayload = buildReferencePayload({ messageRow, message, source, idempotencyKey })

    await getOrCreateMainAgentRuntime()
    await getOrCreateScene({
      kind: isPrivate ? 'qq_private' : 'qq_group',
      externalId: isPrivate ? input.sceneExternalId ?? targetUserId ?? group : group,
    })
    const runtimeEvent = await createOrReuseRuntimeEvent({
      sceneId,
      eventType: isPrivate ? 'qq_private_message_received' : 'qq_group_message_received',
      payload: referencePayload,
      occurredAt: createdAt,
      idempotencyKey,
    })

    const mentioned = !isPrivate && isMentionedSelf(input.segments, options.selfNumber)
    const opportunityType = isPrivate ? 'reply_private_message' : mentioned ? 'reply_to_mention' : 'proactive_candidate'
    const opportunity = await createOrReuseOpportunity({
      sceneId,
      runtimeEventId: runtimeEvent.id,
      queueKind: isPrivate || mentioned ? 'obligation' : 'social',
      opportunityType,
      priority: isPrivate ? 90 : mentioned ? 100 : 1,
      payload: referencePayload,
      status: 'pending',
      idempotencyKey: `${idempotencyKey}:${isPrivate ? 'private_reply' : mentioned ? 'reply' : 'ambient'}`,
    })

    const shouldExecuteMention = mentioned && runtimeOptions.executeDecisions !== false && Boolean(options.passiveWorker)
    const shouldExecutePrivate = isPrivate && runtimeOptions.executeDecisions !== false && Boolean(options.ambientExecutor)
    const actionType: ActionType = isPrivate ? 'send_private_message' : mentioned ? 'reply_to_message' : 'send_group_message'
    const replyDryRunEnabled = options.replyDryRunEnabled === true
    const executorAvailable = shouldExecuteMention || shouldExecutePrivate
    const barrierExecutorAvailable = isPrivate
      ? shouldExecutePrivate
      : mentioned
        ? shouldExecuteMention
        : runtimeOptions.executeDecisions !== false
    const barrierVerdict = decideExecution(
      {
        actionType,
        sourceKind: isPrivate ? 'private_message' : mentioned ? 'mention' : 'ambient_message',
        targetSceneId: sceneId,
        dryRunRequested: replyDryRunEnabled || (!isPrivate && !mentioned),
        executorAvailable: barrierExecutorAvailable,
      },
      {},
      {
        ...DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG,
        privateReplyDryRun: replyDryRunEnabled,
        anchoredGroupReplyDryRun: replyDryRunEnabled,
      },
    )
    const barrierOutput = buildBarrierOutput(barrierVerdict)
    const dryRun = barrierVerdict.effectMode === 'dry_run'
    const allowedToSend = barrierVerdict.effectMode === 'live'
    const decision = await createOrReuseDecision({
      opportunityId: opportunity.id,
      idempotencyKey: `${opportunity.id}:policy`,
      policyVersion: barrierVerdict.policyVersion,
      verdict: verdictFromEffectMode(barrierVerdict.effectMode),
      actionType,
      riskLevel: barrierVerdict.riskBand,
      reason: replyDryRunEnabled && executorAvailable
        ? 'reply dry-run is enabled; generation may run but external send is disabled'
        : shouldExecutePrivate
          ? 'direct QQ private message may execute private reply'
          : isPrivate
            ? 'private reply decisions disabled or reply executor unavailable'
            : shouldExecuteMention
              ? 'direct @self mention may execute anchored group reply'
              : mentioned
                ? 'mention reply decisions disabled or passive worker unavailable'
                : 'ordinary group proactive is dry-run before Phase 10',
      barrierInput: buildBarrierPayload({
        sceneId,
        targetUserId,
        messageRowId: messageRow,
        messageId: message,
        opportunityType,
        actionType,
        dryRun,
      }),
      barrierOutput: {
        ...barrierOutput,
        allowedToSend,
        dryRun,
        dispatchMode: barrierVerdict.effectMode,
        sideEffect: allowedToSend ? 'napcat_send' : dryRun ? 'audit_write' : 'none',
        reason: replyDryRunEnabled && executorAvailable
          ? 'reply dry-run is enabled; external send is disabled'
          : shouldExecutePrivate
            ? 'private reply is allowed'
            : isPrivate
              ? 'snapshot-only private message cannot send'
              : shouldExecuteMention
                ? 'anchored mention reply is allowed'
                : mentioned
                  ? 'snapshot-only mention cannot send'
                  : 'ordinary group proactive send is disabled before Phase 10',
      },
    })

    const snapshot = {
      agentId: MAIN_AGENT_ID,
      schemaVersion: 1,
      contextSnapshot: { messages: [] },
      sessionSnapshot: { focusedTargetId: sceneId, scenes: [sceneId], sceneCursors: { [sceneId]: messageRow }, lastObservedMessageRowId: messageRow },
      lastObservedMessageRowId: messageRow,
      updatedAt: createdAt,
    }
    snapshots.set(sceneId, snapshot)
    await upsertAgentRuntimeSnapshot({
      contextSnapshot: snapshot.contextSnapshot,
      sessionSnapshot: snapshot.sessionSnapshot,
    })

    const executionContext: OpportunityExecutionContext = {
      sceneId,
      group,
      targetUserId,
      messageRow,
      message,
      senderId: asNumber(input['senderId']),
      createdAt,
    }

    if (opportunity.status !== 'pending') return

    if (runtimeOptions.executeDecisions === false) {
      await recordSkippedAction({
        opportunity,
        context: executionContext,
        decisionId: decision.id,
        actionType,
        dryRun,
        riskLevel: barrierVerdict.riskBand,
        deliveryState: 'suppressed',
        barrierOutput,
        reason: isPrivate
          ? 'private reply decisions disabled'
          : mentioned
            ? 'mention reply decisions disabled'
            : 'ordinary group proactive dry-run only before Phase 10',
      })
      await markOpportunityStatus(opportunity.id, 'skipped')
      return
    }

    const pendingOpportunities = await listPendingArbiterOpportunities({ limit: 50 })
    const arbiterOpportunities = pendingOpportunities.some((candidate) => candidate.id === opportunity.id)
      ? pendingOpportunities
      : [opportunity, ...pendingOpportunities]
    await arbitrateAndExecute(
      arbiterOpportunities,
      runtimeOptions,
      new Map([[opportunity.id, executionContext]]),
    )
  }

  return {
    async restore(groups: number[]) {
      await getOrCreateMainAgentRuntime()
      const persisted = await getAgentRuntimeSnapshot()
      const sceneCursors = readSceneCursors(persisted?.sessionSnapshot)
      for (const group of groups) {
        await getOrCreateScene({ kind: 'qq_group', externalId: group })
        const sceneId = makeQqGroupSceneId(group)
        const cursor = sceneCursors[sceneId]
        if (cursor !== undefined) {
          snapshots.set(sceneId, {
            agentId: MAIN_AGENT_ID,
            schemaVersion: 1,
            contextSnapshot: { messages: [] },
            sessionSnapshot: { focusedTargetId: sceneId, scenes: [sceneId], sceneCursors: { [sceneId]: cursor }, lastObservedMessageRowId: cursor },
            lastObservedMessageRowId: cursor,
          })
        }
      }
      return { restoredCount: groups.length }
    },
    async emitRuntimeEvent(event, runtimeOptions = {}) {
      if (event.eventKind === 'scheduler_tick' || event.eventKind === 'manual_wake') {
        await drainArbiterQueue(runtimeOptions)
        return
      }
      if (event.eventKind !== 'group_message' && event.eventKind !== 'private_message') return
      const message = asMessage(event)
      if (!message) return
      await materializeMessage(message, runtimeOptions)
    },
    async ingestGroupMessage(input, runtimeOptions = {}) {
      await materializeMessage(input, runtimeOptions)
    },
    async ingestPrivateMessage(input, runtimeOptions = {}) {
      await materializeMessage(input, runtimeOptions)
    },
    getSnapshot(group) {
      return snapshots.get(makeQqGroupSceneId(group)) ?? null
    },
    async primeGroupCursor(input) {
      const group = asNumber(input['groupId'])
      const sceneId = makeQqGroupSceneId(group)
      const cursor = asNumber(input['lastObservedMessageRowId'])
      snapshots.set(sceneId, {
        agentId: MAIN_AGENT_ID,
        schemaVersion: 1,
        contextSnapshot: { messages: [] },
        sessionSnapshot: { focusedTargetId: sceneId, scenes: [sceneId], sceneCursors: { [sceneId]: cursor }, lastObservedMessageRowId: cursor },
        lastObservedMessageRowId: cursor,
      })
      await upsertAgentRuntimeSnapshot({
        contextSnapshot: { messages: [] },
        sessionSnapshot: { focusedTargetId: sceneId, scenes: [sceneId], sceneCursors: { [sceneId]: cursor }, lastObservedMessageRowId: cursor },
      })
    },
    requeuePendingPassiveMentions() {
      return 0
    },
    async markPassiveReplyDelivered() {},
    dispatchPassiveMentionIfMentioned() {
      return false
    },
    enqueuePassiveMention() {},
    startPassiveExecution() {},
    stopPassiveExecution() {},
  }
}

export function getGroupRuntimeKey(): string {
  return MAIN_AGENT_ID
}
