import type { ParsedSegment } from '../types/message-segments.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import type { BusinessLogIngestSource } from '../utils/business-log.js'
import {
  createOrReuseActionIntent,
  createOrReuseActionRecord,
  createOrReuseOpportunity,
  createOrReuseRuntimeEvent,
  getOrCreateMainAgentRuntime,
  getOrCreateScene,
  upsertAgentRuntimeSnapshot,
} from './agent-runtime-store.js'
import {
  listRootRuntimeSnapshotsByGroupIds,
  upsertRootRuntimeSnapshot,
} from './snapshot-store.js'
import {
  buildMessageReferencePayload,
  createOrReuseOpportunity,
  createOrReuseRuntimeEvent,
  ensureQqGroupScene,
} from './agent-runtime-store.js'

const log = createLogger('ROOT_RUNTIME')
const ROOT_RUNTIME_CONTEXT_MESSAGE_LIMIT = 200
const PROACTIVE_JUDGE_RECENT_MESSAGE_LIMIT = 12
const DEFAULT_AMBIENT_REPLY_BASE_PROBABILITY = 0.02

export type RuntimeEventKind = 'group_message' | 'scheduler_tick' | 'manual_wake'

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
  passiveWorker?: (batch: any) => Promise<any> | any
  onReplyRecordSent?: (record: any) => Promise<void> | void
}

const snapshots = new Map<SceneId, Record<string, unknown>>()

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
}) {
  return {
    messageRowId: input.messageRow,
    messageId: input.message,
    ingestSource: input.source,
    source: 'messages',
    idempotencyKey: input.idempotencyKey,
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
      eventType: 'group_message',
      payload: referencePayload,
      occurredAt: createdAt,
      idempotencyKey,
    })

    const mentioned = isMentionedSelf(input.segments, options.selfNumber)
    const opportunity = await createOrReuseOpportunity({
      sceneId,
      runtimeEventId: runtimeEvent.id,
      queueKind: mentioned ? 'obligation' : 'social',
      opportunityType: mentioned ? 'reply_to_mention' : 'ambient_candidate',
      priority: mentioned ? 100 : 1,
      payload: referencePayload,
      status: 'pending',
      idempotencyKey: `${idempotencyKey}:${mentioned ? 'reply' : 'ambient'}`,
    })

    const text = segmentsToPlainText(input.segments).trim()
    const intent = await createOrReuseActionIntent({
      opportunityId: opportunity.id,
      actionType: mentioned ? 'reply_to_message' : 'artifact_only',
      targetSceneId: sceneId,
      payload: {
        ['groupId']: group,
        messageId: message,
        messageRowId: messageRow,
        text,
        opportunityType: mentioned ? 'reply_to_mention' : 'ambient_candidate',
      },
      dryRun: !mentioned,
      riskLevel: mentioned ? 'medium' : 'low',
      status: mentioned ? 'pending' : 'suppressed',
      idempotencyKey: `${opportunity.id}:action`,
    })

    await createOrReuseActionRecord({
      actionIntentId: intent.id,
      actionType: intent.actionType as 'reply_to_message' | 'artifact_only',
      targetSceneId: sceneId,
      deliveryState: mentioned ? 'pending' : 'dry_run',
      idempotencyKey: intent.idempotencyKey,
      resultPayload: mentioned ? null : { reason: 'ambient_candidate dryRun artifact-only' },
    })

    const snapshot = {
      agentId: MAIN_AGENT_ID,
      schemaVersion: 1,
      contextSnapshot: {
        messages: [{ role: 'user', kind: 'group_message', orderKey: messageRow, senderId: asNumber(input['senderId']), content: text }],
      },
      sessionSnapshot: { focusedTargetId: sceneId, scenes: [sceneId], lastObservedMessageRowId: messageRow },
      lastObservedMessageRowId: messageRow,
      updatedAt: createdAt,
    }
    snapshots.set(sceneId, snapshot)
    await upsertAgentRuntimeSnapshot({
      contextSnapshot: snapshot.contextSnapshot,
      sessionSnapshot: snapshot.sessionSnapshot,
    })
  }

  return {
    async restore(groups: number[]) {
      await getOrCreateMainAgentRuntime()
      for (const group of groups) {
        await getOrCreateScene({ kind: 'qq_group', externalId: group })
      }
      return { restoredCount: groups.length }
    },
    async emitRuntimeEvent(event, runtimeOptions = {}) {
      if (event.eventKind !== 'group_message') return
      const message = asMessage(event)
      if (!message) return
      await materializeMessage(message, runtimeOptions)
    },

    async ingestGroupMessage(input, ingestOptions = {}) {
      const existing = snapshots.get(input.groupId)
      const current = existing ?? {
        ...createDefaultRootRuntimeSnapshot(input.groupId),
        id: 0,
        createdAt: now(),
        updatedAt: now(),
      }
      const currentLastObserved = current.lastObservedMessageRowId ?? 0
      const alreadyObserved = current.sessionSnapshot.recentObservedMessageRowIds.includes(input.messageRowId)
      if (alreadyObserved) {
        return
      }

      const mentionedSelf = isMentionedSelf(input.segments, options.selfNumber)
        || pendingMentionHints.get(input.groupId)?.has(input.messageId)
        || false
      const scene = await ensureQqGroupScene({ groupId: input.groupId })
      const sceneId = scene.id as ReturnType<typeof makeSceneId>
      const messageIdempotencyKey = `group_message:${input.messageRowId}`
      const referencePayload = buildMessageReferencePayload({
        messageRowId: input.messageRowId,
        messageId: input.messageId,
        ingestSource: ingestOptions.ingestSource,
        source: 'qq_group',
        idempotencyKey: messageIdempotencyKey,
      })
      const runtimeEvent = await createOrReuseRuntimeEvent({
        sceneId,
        eventType: 'group_message',
        payload: referencePayload,
        occurredAt: input.createdAt,
        idempotencyKey: messageIdempotencyKey,
      })
      const senderThreadKey = toSenderThreadKey(input.senderId)
      const updatedAt = input.createdAt.toISOString()
      pendingMentionHints.get(input.groupId)?.delete(input.messageId)
      const nextUnreadMessages = upsertUnreadMessage(
        current.sessionSnapshot.unreadMessages,
        {
          messageRowId: input.messageRowId,
          messageId: input.messageId,
          senderId: input.senderId,
          senderNickname: input.senderNickname,
          mentionedSelf,
          createdAt: updatedAt,
        },
        unreadLimit,
      )

      const continuityByKey = new Map(
        current.sessionSnapshot.senderContinuities.map((continuity) => [continuity.senderThreadKey, continuity]),
      )
      const existingContinuity = continuityByKey.get(senderThreadKey)
      continuityByKey.set(senderThreadKey, {
        senderThreadKey,
        senderId: input.senderId,
        lastSeenMessageRowId: Math.max(existingContinuity?.lastSeenMessageRowId ?? 0, input.messageRowId),
        lastMaterializedMessageRowId: existingContinuity?.lastMaterializedMessageRowId ?? null,
        updatedAt,
      })

      const nextSenderContinuities = [...continuityByKey.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, senderContinuityLimit)
      const nextRecentObservedMessageRowIds = [
        ...current.sessionSnapshot.recentObservedMessageRowIds.filter((rowId) => rowId !== input.messageRowId),
        input.messageRowId,
      ].slice(-RECENT_OBSERVED_MESSAGE_ROW_IDS_LIMIT)
      const nextOutstandingCues = mentionedSelf
        ? upsertCue(current.sessionSnapshot.outstandingCues, {
            cueId: makeMentionCueId(sceneId, input.messageRowId),
            sceneId,
            cueKind: 'message',
            triggerMessageRowId: input.messageRowId,
            messageId: input.messageId,
            senderId: input.senderId,
            senderNickname: input.senderNickname,
            addressedToAgent: true,
            cueStrength: 'strong',
            replyModeHint: 'anchored',
            preferredDeliveryMode: 'reply_to_message',
            mustReplyOverride: true,
            status: 'pending',
            createdAt: updatedAt,
          })
        : (current.sessionSnapshot.outstandingCues ?? [])
      const previousSceneRecord = (current.sessionSnapshot.sceneRecords ?? []).find((record) => record.sceneId === sceneId)
      const nextSceneRecords = upsertSceneRecord(
        current.sessionSnapshot.sceneRecords,
        buildSceneRecord({
          groupId: input.groupId,
          previous: previousSceneRecord,
          unreadMessages: nextUnreadMessages,
          lastObservedMessageRowId: Math.max(currentLastObserved, input.messageRowId),
          lastMaterializedReplyRowId: previousSceneRecord?.lastMaterializedReplyRowId ?? null,
          outstandingCues: nextOutstandingCues,
        }),
      )

      const nextSnapshotInput: CreateRootRuntimeSnapshotInput = {
        runtimeKey: current.runtimeKey,
        groupId: input.groupId,
        schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
        contextSnapshot: {
          messages: upsertContextSnapshotMessage(current.contextSnapshot.messages, {
            role: 'user',
            kind: 'group_message',
            orderKey: input.messageRowId,
            senderId: input.senderId,
            content: `[QQ消息]\n${input.senderNickname}: ${segmentsToPlainText(input.segments)}`,
          }),
        },
        sessionSnapshot: {
          ...current.sessionSnapshot,
          focusedTargetId: current.sessionSnapshot.focusedTargetId ?? sceneId,
          unreadMessages: nextUnreadMessages,
          senderContinuities: nextSenderContinuities,
          sceneRecords: nextSceneRecords,
          outstandingCues: nextOutstandingCues,
          recentObservedMessageRowIds: nextRecentObservedMessageRowIds,
        },
        lastObservedMessageRowId: Math.max(currentLastObserved, input.messageRowId),
      }

      const persisted = await snapshotStore.upsert(nextSnapshotInput)
      snapshots.set(input.groupId, persisted)

      const executeDecisions = ingestOptions.executeDecisions ?? true
      const plainText = segmentsToPlainText(input.segments)
      const replyProbability = mentionedSelf
        ? 1
        : scoreAmbientReplyProbability({
            segments: input.segments,
            baseProbability: ambientReplyBaseProbability,
          })
      const gateReasons = !mentionedSelf
        ? getProactiveGateReasons({
            groupId: input.groupId,
            createdAt: input.createdAt,
            segments: input.segments,
            text: plainText,
            triggerMessageRowId: input.messageRowId,
            snapshot: persisted,
          })
        : []
      const judgeAdvice = !mentionedSelf
        && executeDecisions
        ? await evaluateProactiveJudge({
            message: input,
            replyProbability,
            gateReasons,
            snapshot: persisted,
          })
        : undefined
      const opportunityKind = mentionedSelf ? 'mention' : 'ambient_message'
      const opportunityIdempotencyKey = `${messageIdempotencyKey}:${opportunityKind}`
      await createOrReuseOpportunity({
        id: `${sceneId}:opportunity:${opportunityIdempotencyKey}`,
        sceneId,
        runtimeEventId: runtimeEvent.id,
        queueKind: mentionedSelf ? 'anchored_reply' : 'ambient_candidate',
        opportunityType: opportunityKind,
        priority: mentionedSelf ? 100 : Math.round(replyProbability * 100),
        payload: referencePayload,
        status: 'pending',
        idempotencyKey: opportunityIdempotencyKey,
      })

      const opportunity: ReplyOpportunity = mentionedSelf
        ? {
            opportunityId: `qq_group:${input.groupId}:message:${input.messageRowId}:mention`,
            runtimeKey: current.runtimeKey,
            groupId: input.groupId,
            sceneId,
            scopeKey: toSenderReplyScopeKey(input.senderId),
            sourceKind: 'mention',
            cueStrength: 'strong',
            mustReplyOverride: true,
            replyProbability,
            anchorMessageRowId: input.messageRowId,
            triggerMessageRowId: input.messageRowId,
            triggerMessageId: input.messageId,
            triggerSenderId: input.senderId,
            incorporatedMessageRowId: input.messageRowId,
            incorporatedMessageId: input.messageId,
            deliveryMode: 'reply_to_message',
            dryRun: false,
            reason: '@self strong anchored opportunity',
            createdAt: input.createdAt,
          }
        : {
            opportunityId: `qq_group:${input.groupId}:message:${input.messageRowId}:ambient`,
            runtimeKey: current.runtimeKey,
            groupId: input.groupId,
            sceneId,
            scopeKey: sceneId,
            sourceKind: 'ambient_message',
            cueStrength: 'weak',
            mustReplyOverride: false,
            replyProbability,
            triggerMessageRowId: input.messageRowId,
            triggerMessageId: input.messageId,
            triggerSenderId: input.senderId,
            incorporatedMessageRowId: input.messageRowId,
            incorporatedMessageId: input.messageId,
            deliveryMode: 'send_message',
            dryRun: true,
            reason: gateReasons.length > 0
              ? `ambient group message suppressed by gates: ${gateReasons.join(',')}`
              : 'ambient group message baseline weak opportunity; proactive candidate dry-run only',
            gateReasons,
            judgeAdvice,
            createdAt: input.createdAt,
          }

      log.info(
        {
          direction: 'internal',
          actor: 'system',
          category: mentionedSelf ? 'mention' : 'ambient_message',
          flow: 'runtime_classification',
          ingestSource: ingestOptions.ingestSource,
          groupId: input.groupId,
          messageId: input.messageId,
          messageRowId: input.messageRowId,
          senderId: input.senderId,
          senderNickname: input.senderNickname,
          mentionedSelf,
          sourceKind: opportunity.sourceKind,
          cueStrength: opportunity.cueStrength,
          deliveryMode: opportunity.deliveryMode,
          replyProbability: opportunity.replyProbability,
          gateReasons: opportunity.gateReasons ?? [],
          judgeAdvice: opportunity.judgeAdvice,
          executeDecisions,
          dispatchMode: executeDecisions ? 'live' : 'snapshot_only',
          sideEffect: 'snapshot_write',
          ...summarizeSegments(input.segments),
        },
        '消息归类完成',
      )

      if (!executeDecisions) {
        return
      }

      if ((mentionedSelf ? liveMentionDecisionEnabled : ambientDecisionEnabled) && replyExecutor) {
        await replyExecutor.execute(opportunity)
      } else if (passiveDispatchEnabled && mentionedSelf) {
        getMailbox(input.groupId).addMention({
          groupId: input.groupId,
          messageId: input.messageId,
          messageRowId: input.messageRowId,
          senderId: input.senderId,
          createdAt: input.createdAt.getTime(),
        })
      }
    },
    getSnapshot(group) {
      return snapshots.get(makeQqGroupSceneId(group)) ?? null
    },
    async primeGroupCursor(input) {
      const group = asNumber(input['groupId'])
      const sceneId = makeQqGroupSceneId(group)
      snapshots.set(sceneId, {
        agentId: MAIN_AGENT_ID,
        schemaVersion: 1,
        contextSnapshot: { messages: [] },
        sessionSnapshot: { focusedTargetId: sceneId, scenes: [sceneId], lastObservedMessageRowId: input['lastObservedMessageRowId'] },
        lastObservedMessageRowId: input['lastObservedMessageRowId'],
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
