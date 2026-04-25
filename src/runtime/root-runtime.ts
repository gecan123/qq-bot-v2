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
  type ActionType,
  type ReferencePayload,
  type SceneId,
} from './agent-runtime-types.js'
import type { GroupConversationBatch } from '../conversation/types.js'
import type { ReplyExecutionResult, ReplyOpportunity } from './reply-decision-types.js'

export type RuntimeEventKind = 'group_message' | 'scheduler_tick' | 'manual_wake'
const RUNTIME_POLICY_VERSION = 'runtime-os.phase1.v1'

export interface PersistedGroupMessageIngress {
  [key: string]: unknown
  messageRowId: number
  messageId: number
  segments: ParsedSegment[]
}

export interface RuntimeEvent {
  [key: string]: unknown
  eventKind?: RuntimeEventKind
  createdAt: Date
  message?: PersistedGroupMessageIngress
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

function asMessage(input: Record<string, unknown>): PersistedGroupMessageIngress | null {
  const message = input.message
  if (message && typeof message === 'object') return message as PersistedGroupMessageIngress
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
    },
    opportunityType: input.opportunityType,
    actionType: input.actionType,
    dryRun: input.dryRun,
  }
}

function buildActionIntentPayload(input: {
  sceneId: SceneId
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
    },
    decisionId: input.decisionId,
    proposedEffect: {
      type: input.actionType,
      generatedTextStatus: input.generatedTextStatus ?? 'not_generated',
    },
    dryRun: input.dryRun,
  }
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

export function createRootRuntimeManager(options: RootRuntimeManagerOptions): RootRuntimeManager {
  const now = options.now ?? (() => new Date())

  async function materializeMessage(input: PersistedGroupMessageIngress, runtimeOptions: PersistedGroupMessageIngressOptions = {}) {
    const group = asNumber(input['groupId'])
    const messageRow = asNumber(input['messageRowId'])
    const message = asNumber(input['messageId'])
    const createdAt = asDate(input['createdAt'], now())
    const source = runtimeOptions.ingestSource ?? 'realtime'
    const sceneId = makeQqGroupSceneId(group)
    const idempotencyKey = `message:${messageRow}`
    const referencePayload = buildReferencePayload({ messageRow, message, source, idempotencyKey })

    await getOrCreateMainAgentRuntime()
    await getOrCreateScene({ kind: 'qq_group', externalId: group })
    const runtimeEvent = await createOrReuseRuntimeEvent({
      sceneId,
      eventType: 'qq_group_message_received',
      payload: referencePayload,
      occurredAt: createdAt,
      idempotencyKey,
    })

    const mentioned = isMentionedSelf(input.segments, options.selfNumber)
    const opportunityType = mentioned ? 'reply_to_mention' : 'proactive_candidate'
    const opportunity = await createOrReuseOpportunity({
      sceneId,
      runtimeEventId: runtimeEvent.id,
      queueKind: mentioned ? 'obligation' : 'social',
      opportunityType,
      priority: mentioned ? 100 : 1,
      payload: referencePayload,
      status: 'pending',
      idempotencyKey: `${idempotencyKey}:${mentioned ? 'reply' : 'ambient'}`,
    })

    const shouldExecuteMention = mentioned && runtimeOptions.executeDecisions !== false && Boolean(options.passiveWorker)
    const actionType: ActionType = mentioned ? 'reply_to_message' : 'send_group_message'
    const dryRun = !mentioned || !shouldExecuteMention
    const decision = await createOrReuseDecision({
      opportunityId: opportunity.id,
      idempotencyKey: `${opportunity.id}:policy`,
      policyVersion: RUNTIME_POLICY_VERSION,
      verdict: shouldExecuteMention ? 'approved' : dryRun ? 'dry_run' : 'skipped',
      actionType,
      riskLevel: 'L3',
      reason: shouldExecuteMention
        ? 'direct @self mention may execute anchored group reply'
        : mentioned
          ? 'mention replay decisions disabled or passive worker unavailable'
          : 'ordinary group proactive is dry-run before Phase 10',
      barrierInput: buildBarrierPayload({
        sceneId,
        messageRowId: messageRow,
        messageId: message,
        opportunityType,
        actionType,
        dryRun,
      }),
      barrierOutput: {
        verdict: shouldExecuteMention ? 'approved' : dryRun ? 'dry_run' : 'skipped',
        allowedToSend: shouldExecuteMention,
        reason: shouldExecuteMention
          ? 'anchored mention reply is allowed'
          : mentioned
            ? 'snapshot-only mention cannot send'
            : 'ordinary group proactive send is disabled before Phase 10',
      },
    })

    if (!shouldExecuteMention) {
      const suppressedMention = mentioned && runtimeOptions.executeDecisions === false
      const intent = await createOrReuseActionIntent({
        opportunityId: opportunity.id,
        decisionId: decision.id,
        actionType,
        targetSceneId: sceneId,
        payload: buildActionIntentPayload({
          sceneId,
          messageRowId: messageRow,
          messageId: message,
          decisionId: decision.id,
          actionType,
          dryRun,
        }),
        dryRun,
        riskLevel: 'L3',
        status: mentioned && !suppressedMention ? 'proposed' : 'skipped',
        idempotencyKey: `${opportunity.id}:action`,
      })

      await createOrReuseActionRecord({
        actionIntentId: intent.id,
        actionType: intent.actionType as ActionType,
        targetSceneId: sceneId,
        deliveryState: suppressedMention ? 'suppressed' : 'dry_run',
        idempotencyKey: intent.idempotencyKey,
        resultPayload: {
          decisionId: decision.id,
          reason: mentioned
            ? 'mention replay decisions disabled'
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

    if (!mentioned && runtimeOptions.executeDecisions !== false && options.ambientExecutor) {
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
      if (event.eventKind !== 'group_message') return
      const message = asMessage(event)
      if (!message) return
      await materializeMessage(message, runtimeOptions)
    },
    async ingestGroupMessage(input, runtimeOptions = {}) {
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
