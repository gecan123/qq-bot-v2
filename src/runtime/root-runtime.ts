import type { ParsedSegment } from '../types/message-segments.js'
import type { BusinessLogIngestSource } from '../utils/business-log.js'
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
  upsertAgentRuntimeSnapshot,
} from './agent-runtime-store.js'
import {
  MAIN_AGENT_ID,
  makeQqGroupSceneId,
  makeQqPrivateSceneId,
  type ActionType,
  type ReferencePayload,
  type SceneId,
} from './agent-runtime-types.js'
import type { GroupConversationBatch } from '../conversation/types.js'
import type { ReplyExecutionResult, ReplyOpportunity } from './reply-decision-types.js'

export type RuntimeEventKind = 'group_message' | 'private_message' | 'scheduler_tick' | 'manual_wake'
const RUNTIME_POLICY_VERSION = 'runtime-os.phase1.v1'

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
  passiveWorker?: (batch: GroupConversationBatch) => Promise<any> | any
  ambientExecutor?: { execute(opportunity: ReplyOpportunity): Promise<ReplyExecutionResult> }
  ambientReplyBaseProbability?: number
  replyDryRunEnabled?: boolean
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
    reason: 'direct QQ private message is an L2 private reply opportunity',
    createdAt: input.createdAt,
  }
}

export function createRootRuntimeManager(options: RootRuntimeManagerOptions): RootRuntimeManager {
  const now = options.now ?? (() => new Date())

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
    const sendableSocialOpportunity = isPrivate || mentioned
    const replyDryRunEnabled = options.replyDryRunEnabled === true
    const executorAvailable = shouldExecuteMention || shouldExecutePrivate
    const dryRun = sendableSocialOpportunity ? replyDryRunEnabled || !executorAvailable : true
    const allowedToSend = executorAvailable && !replyDryRunEnabled
    const barrierVerdict = allowedToSend ? 'approved' : dryRun ? 'dry_run' : 'skipped'
    const decision = await createOrReuseDecision({
      opportunityId: opportunity.id,
      idempotencyKey: `${opportunity.id}:policy`,
      policyVersion: RUNTIME_POLICY_VERSION,
      verdict: barrierVerdict,
      actionType,
      riskLevel: isPrivate ? 'L2' : 'L3',
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
        verdict: barrierVerdict,
        allowedToSend,
        dryRun,
        dispatchMode: allowedToSend ? 'live' : dryRun ? 'dry_run' : 'skipped',
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

    if (!shouldExecuteMention && !shouldExecutePrivate) {
      const suppressedMention = mentioned && runtimeOptions.executeDecisions === false
      const suppressedPrivate = isPrivate && runtimeOptions.executeDecisions === false
      const intent = await createOrReuseActionIntent({
        opportunityId: opportunity.id,
        decisionId: decision.id,
        actionType,
        targetSceneId: sceneId,
        payload: buildActionIntentPayload({
          sceneId,
          targetUserId,
          messageRowId: messageRow,
          messageId: message,
          decisionId: decision.id,
          actionType,
          dryRun,
        }),
        dryRun,
        riskLevel: isPrivate ? 'L2' : 'L3',
        status: (mentioned && !suppressedMention) || (isPrivate && !suppressedPrivate) ? 'proposed' : 'skipped',
        idempotencyKey: `${opportunity.id}:action`,
      })

      await createOrReuseActionRecord({
        actionIntentId: intent.id,
        actionType: intent.actionType as ActionType,
        targetSceneId: sceneId,
        deliveryState: suppressedMention || suppressedPrivate ? 'suppressed' : 'dry_run',
        idempotencyKey: intent.idempotencyKey,
        resultPayload: {
          decisionId: decision.id,
          reason: isPrivate
            ? 'private reply decisions disabled'
            : mentioned
              ? 'mention reply decisions disabled'
              : 'ordinary group proactive dry-run only before Phase 10',
        },
      })
    }

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

    if (shouldExecutePrivate && options.ambientExecutor && targetUserId != null) {
      await options.ambientExecutor.execute(buildPrivateReplyOpportunity({
        sceneId,
        userId: targetUserId,
        messageRowId: messageRow,
        messageId: message,
        senderId: asNumber(input['senderId']),
        opportunityId: opportunity.id,
        decisionId: decision.id,
        dryRun: replyDryRunEnabled,
        createdAt,
      }))
    }

    if (shouldExecuteMention && options.passiveWorker) {
      await options.passiveWorker({
        ['groupId']: group,
        events: [{
          ['groupId']: group,
          messageId: message,
          messageRowId: messageRow,
          senderId: asNumber(input['senderId']),
          runtimeOpportunityId: opportunity.id,
          runtimeDecisionId: decision.id,
          runtimeSceneId: sceneId,
          createdAt: createdAt.getTime(),
        }],
        openedAt: createdAt.getTime(),
        closedAt: now().getTime(),
      })
    }

    if (!isPrivate && !mentioned && runtimeOptions.executeDecisions !== false && options.ambientExecutor) {
      await options.ambientExecutor.execute(buildAmbientReplyOpportunity({
        sceneId,
        groupId: group,
        messageRowId: messageRow,
        messageId: message,
        senderId: asNumber(input['senderId']),
        opportunityId: opportunity.id,
        decisionId: decision.id,
        replyProbability: typeof options.ambientReplyBaseProbability === 'number' ? options.ambientReplyBaseProbability : 0.02,
        createdAt,
      }))
    }
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
