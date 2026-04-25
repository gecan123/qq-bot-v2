import type { ParsedSegment } from '../types/message-segments.js'
import { createLogger } from '../logger.js'
import { createGroupMailbox, type GroupMailbox } from '../conversation/group-mailbox.js'
import { toSenderThreadKey } from '../conversation/thread-key.js'
import type { ConversationWorkerResult, GroupConversationBatch, MentionEvent } from '../conversation/types.js'
import { toSenderReplyScopeKey } from '../conversation/reply-scope.js'
import { createReplyExecutor, type ReplyExecutor, type ReplyExecutorOptions } from './reply-executor.js'
import { createReplyDecisionEngine, type ReplyDecisionEngine } from './reply-decision-engine.js'
import type { ReplyOpportunity } from './reply-decision-types.js'
import {
  createDisabledProactiveJudgeAdvice,
  createInvalidProactiveJudgeAdvice,
  createProactiveJudge,
  type ProactiveJudge,
} from './proactive-judge.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import { summarizeSegments } from '../utils/business-log.js'
import { config } from '../config/index.js'
import {
  createDefaultRootRuntimeSnapshot,
  DEFAULT_ROOT_RUNTIME_SENDER_CONTINUITY_LIMIT,
  DEFAULT_ROOT_RUNTIME_UNREAD_LIMIT,
  makeMentionCueId,
  makeSceneId,
  makeGroupRuntimeKey,
  ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  type CreateRootRuntimeSnapshotInput,
  type RuntimeCue,
  type RuntimeContextMessage,
  type ProactiveCandidateArtifact,
  type RuntimeSceneRecord,
  type RuntimeProactiveJudgeAttempt,
  type RuntimeUnreadMessage,
  type RootRuntimeSnapshotRecord,
} from './types.js'
import {
  listRootRuntimeSnapshotsByGroupIds,
  upsertRootRuntimeSnapshot,
} from './snapshot-store.js'

const log = createLogger('ROOT_RUNTIME')
const ROOT_RUNTIME_CONTEXT_MESSAGE_LIMIT = 200
const PROACTIVE_JUDGE_RECENT_MESSAGE_LIMIT = 12
const DEFAULT_AMBIENT_REPLY_BASE_PROBABILITY = 0.02

export type RuntimeEventKind = 'group_message' | 'scheduler_tick' | 'manual_wake'

export interface RuntimeEvent {
  eventKind: RuntimeEventKind
  groupId: number
  createdAt: Date
  message?: PersistedGroupMessageIngress
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function scoreAmbientReplyProbability(input: { segments: ParsedSegment[]; baseProbability: number }): number {
  const text = segmentsToPlainText(input.segments).trim()
  if (!text) return 0

  let score = clampProbability(input.baseProbability)
  if (/[?？]/.test(text)) score += 0.06
  if (/(bot|机器人|有人吗|在吗|怎么|为什么|咋|求助|帮忙)/i.test(text)) score += 0.04
  if (text.length >= 80) score += 0.02
  return clampProbability(score)
}

function hasConcreteAmbientAnchor(input: { segments: ParsedSegment[]; text: string }): boolean {
  const text = input.text.trim()
  if (!text) return false
  if (/[?？]/.test(text)) return true
  if (/(bot|机器人|有人吗|在吗|怎么|为什么|咋|求助|帮忙|报错|失败|排查|处理|解决|哪里|哪个|谁知道)/i.test(text)) {
    return true
  }
  if (text.length >= 80) return true
  return input.segments.some((segment) =>
    (segment.type === 'image' || segment.type === 'video' || segment.type === 'record' || segment.type === 'file') &&
    Boolean(segment.mediaDescription),
  )
}

export interface PersistedGroupMessageIngress {
  groupId: number
  messageRowId: number
  messageId: number
  senderId: number
  senderNickname: string
  segments: ParsedSegment[]
  createdAt: Date
}

export interface PersistedGroupMessageIngressOptions {
  executeDecisions?: boolean
}

export interface RuntimeEventOptions extends PersistedGroupMessageIngressOptions {}

export interface RootRuntimeManager {
  restore(groupIds: number[]): Promise<{ restoredCount: number }>
  emitRuntimeEvent(event: RuntimeEvent, options?: RuntimeEventOptions): Promise<void>
  ingestGroupMessage(input: PersistedGroupMessageIngress, options?: PersistedGroupMessageIngressOptions): Promise<void>
  getSnapshot(groupId: number): RootRuntimeSnapshotRecord | null
  primeGroupCursor(input: { groupId: number; lastObservedMessageRowId: number }): Promise<void>
  requeuePendingPassiveMentions(groupIds?: number[]): number
  markPassiveReplyDelivered(input: {
    groupId: number
    senderId: number
    incorporatedMessageRowId: number
    text: string
  }): Promise<void>
  dispatchPassiveMentionIfMentioned(input: {
    groupId: number
    messageId: number
    senderId: number
    createdAt: number
    segments: ParsedSegment[]
  }): boolean
  enqueuePassiveMention(event: MentionEvent): void
  startPassiveExecution(): void
  stopPassiveExecution(): void
}

export interface RootRuntimeManagerOptions {
  selfNumber: number
  unreadLimit?: number
  senderContinuityLimit?: number
  passiveMergeWindowMs?: number
  passiveWorker?: (batch: GroupConversationBatch) => Promise<ConversationWorkerResult | void>
  replyExecutor?: ReplyExecutor
  replyExecutionEnabled?: boolean
  decisionEngine?: ReplyDecisionEngine
  onReplyRecordSent?: ReplyExecutorOptions['onReplyRecordSent']
  ambientAuditEnabled?: boolean
  ambientReplyBaseProbability?: number
  proactivePolicy?: typeof config.proactivePolicy
  proactiveJudge?: ProactiveJudge
  proactiveJudgePolicy?: typeof config.proactiveJudge
  now?: () => Date
  snapshotStore?: {
    listByGroupIds: typeof listRootRuntimeSnapshotsByGroupIds
    upsert: typeof upsertRootRuntimeSnapshot
  }
}

const RECENT_OBSERVED_MESSAGE_ROW_IDS_LIMIT = 256

function isMentionedSelf(segments: ParsedSegment[], selfNumber: number): boolean {
  return segments.some((segment) => segment.type === 'at' && segment.targetId === String(selfNumber))
}

function compareContextMessage(left: RuntimeContextMessage, right: RuntimeContextMessage): number {
  if (left.orderKey !== right.orderKey) {
    return left.orderKey - right.orderKey
  }

  if (left.kind !== right.kind) {
    return left.kind === 'group_message' ? -1 : 1
  }

  if (left.senderId !== right.senderId) {
    return left.senderId - right.senderId
  }

  return left.content.localeCompare(right.content)
}

function upsertContextSnapshotMessage(
  messages: RuntimeContextMessage[],
  message: RuntimeContextMessage,
): RuntimeContextMessage[] {
  const dedupeKey = `${message.kind}:${message.orderKey}:${message.senderId}`
  return [
    ...messages.filter((existing) => `${existing.kind}:${existing.orderKey}:${existing.senderId}` !== dedupeKey),
    message,
  ]
    .sort(compareContextMessage)
    .slice(-ROOT_RUNTIME_CONTEXT_MESSAGE_LIMIT)
}

function buildProactiveJudgeRecentMessages(snapshot: RootRuntimeSnapshotRecord, triggerMessageRowId: number) {
  return snapshot.contextSnapshot.messages
    .filter((message) => message.kind === 'group_message' && message.orderKey !== triggerMessageRowId)
    .slice(-PROACTIVE_JUDGE_RECENT_MESSAGE_LIMIT)
    .map((message) => ({
      messageRowId: message.orderKey,
      senderId: message.senderId,
      content: message.content,
      createdAt: snapshot.sessionSnapshot.unreadMessages.find((unread) => unread.messageRowId === message.orderKey)?.createdAt
        ?? snapshot.updatedAt.toISOString(),
    }))
}

function upsertUnreadMessage(
  unreadMessages: RuntimeUnreadMessage[],
  message: RuntimeUnreadMessage,
  unreadLimit: number,
): RuntimeUnreadMessage[] {
  return [...unreadMessages.filter((existing) => existing.messageRowId !== message.messageRowId), message]
    .sort((left, right) => left.messageRowId - right.messageRowId)
    .slice(-unreadLimit)
}

function upsertSceneRecord(
  sceneRecords: RuntimeSceneRecord[] | undefined,
  sceneRecord: RuntimeSceneRecord,
): RuntimeSceneRecord[] {
  return [...(sceneRecords ?? []).filter((existing) => existing.sceneId !== sceneRecord.sceneId), sceneRecord].sort((left, right) =>
    left.sceneId.localeCompare(right.sceneId),
  )
}

function upsertCue(outstandingCues: RuntimeCue[] | undefined, cue: RuntimeCue): RuntimeCue[] {
  return [...(outstandingCues ?? []).filter((existing) => existing.cueId !== cue.cueId), cue].sort(
    (left, right) => left.triggerMessageRowId - right.triggerMessageRowId,
  )
}

function buildSceneRecord(input: {
  groupId: number
  previous?: RuntimeSceneRecord
  unreadMessages: RuntimeUnreadMessage[]
  lastObservedMessageRowId: number | null
  lastMaterializedReplyRowId: number | null
  outstandingCues: RuntimeCue[]
  nowIso?: string | null
}): RuntimeSceneRecord {
  const sceneId = makeSceneId(input.groupId)
  return {
    sceneId,
    kind: 'qq_group',
    groupId: input.groupId,
    unreadCount: input.unreadMessages.length,
    lastObservedMessageRowId: input.lastObservedMessageRowId,
    lastMaterializedReplyRowId: input.lastMaterializedReplyRowId,
    lastFocusedAt: input.previous?.lastFocusedAt ?? null,
    lastSpokeAt: input.nowIso ?? input.previous?.lastSpokeAt ?? null,
    outstandingCueIds: input.outstandingCues
      .filter((cue) => cue.sceneId === sceneId && cue.status === 'pending')
      .map((cue) => cue.cueId),
  }
}

export function createRootRuntimeManager(options: RootRuntimeManagerOptions): RootRuntimeManager {
  const unreadLimit = options.unreadLimit ?? DEFAULT_ROOT_RUNTIME_UNREAD_LIMIT
  const senderContinuityLimit = options.senderContinuityLimit ?? DEFAULT_ROOT_RUNTIME_SENDER_CONTINUITY_LIMIT
  const passiveMergeWindowMs = options.passiveMergeWindowMs ?? 1_000
  const now = options.now ?? (() => new Date())
  const replyExecutionEnabled = options.replyExecutionEnabled ?? Boolean(options.replyExecutor)
  const ambientDecisionEnabled = options.ambientAuditEnabled !== false && replyExecutionEnabled
  const liveMentionDecisionEnabled = replyExecutionEnabled
  const ambientReplyBaseProbability = options.ambientReplyBaseProbability ?? DEFAULT_AMBIENT_REPLY_BASE_PROBABILITY
  const proactivePolicy = options.proactivePolicy ?? config.proactivePolicy
  const proactiveJudgePolicy = options.proactiveJudgePolicy ?? config.proactiveJudge
  const proactiveJudge = options.proactiveJudge ?? createProactiveJudge({ policy: proactiveJudgePolicy })
  const snapshotStore = options.snapshotStore ?? {
    listByGroupIds: listRootRuntimeSnapshotsByGroupIds,
    upsert: upsertRootRuntimeSnapshot,
  }
  const snapshots = new Map<number, RootRuntimeSnapshotRecord>()
  const passiveMailboxes = new Map<number, GroupMailbox>()
  const pendingMentionHints = new Map<number, Set<number>>()
  const generationAttemptsByGroup = new Map<number, Date[]>()
  const candidateArtifactsByGroup = new Map<number, Date[]>()
  const judgeCallsByGroup = new Map<number, Date[]>()
  let passiveActive = false
  let passiveDispatchEnabled = false

  const runPassiveGroup = (groupId: number) => {
    if (!passiveActive || !options.passiveWorker) {
      return
    }
    const mailbox = passiveMailboxes.get(groupId)
    if (!mailbox) {
      return
    }
    const batch = mailbox.claimNextBatch()
    if (!batch) {
      return
    }

    void (async () => {
      try {
        const result = await options.passiveWorker?.(batch)
        if (result?.leftoverEvents.length) {
          mailbox.enqueueBatch({
            groupId,
            events: result.leftoverEvents,
            openedAt: result.leftoverEvents[0]?.createdAt ?? Date.now(),
            closedAt: result.leftoverEvents[result.leftoverEvents.length - 1]?.createdAt ?? Date.now(),
          })
        }
      } catch (error) {
        log.error({ error, groupId }, 'root runtime passive mention execution failed')
      } finally {
        mailbox.finishCurrentRun()
        runPassiveGroup(groupId)
      }
    })()
  }

  const getMailbox = (groupId: number): GroupMailbox => {
    const existing = passiveMailboxes.get(groupId)
    if (existing) {
      return existing
    }

    const mailbox = createGroupMailbox({
      groupId,
      mergeWindowMs: passiveMergeWindowMs,
      onBatchReady: () => {
        runPassiveGroup(groupId)
      },
    })
    passiveMailboxes.set(groupId, mailbox)
    return mailbox
  }

  const persistProactiveCandidate = async (artifact: ProactiveCandidateArtifact) => {
    const existing = snapshots.get(artifact.groupId) ?? {
      ...createDefaultRootRuntimeSnapshot(artifact.groupId),
      id: 0,
      createdAt: now(),
      updatedAt: now(),
    }
    const persisted = await snapshotStore.upsert({
      runtimeKey: existing.runtimeKey,
      groupId: artifact.groupId,
      schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: existing.contextSnapshot,
      sessionSnapshot: {
        ...existing.sessionSnapshot,
        proactiveCandidateArtifacts: [
          ...(existing.sessionSnapshot.proactiveCandidateArtifacts ?? []).filter(
            (item) => !(item.runtimeKey === artifact.runtimeKey && item.opportunityId === artifact.opportunityId),
          ),
          artifact,
        ],
      },
      lastObservedMessageRowId: existing.lastObservedMessageRowId,
    })
    snapshots.set(artifact.groupId, persisted)

    if (artifact.status === 'candidate_generated') {
      const bucket = candidateArtifactsByGroup.get(artifact.groupId) ?? []
      bucket.push(new Date(artifact.createdAt))
      candidateArtifactsByGroup.set(artifact.groupId, bucket)
    }
  }

  const getProactiveGateReasons = (input: {
    groupId: number
    createdAt: Date
    segments: ParsedSegment[]
    text: string
    triggerMessageRowId: number
    snapshot: RootRuntimeSnapshotRecord
  }): string[] => {
    const reasons: string[] = []
    if (!hasConcreteAmbientAnchor({ segments: input.segments, text: input.text })) reasons.push('no_concrete_anchor')

    const nowMs = input.createdAt.getTime()
    const activeChatCount = input.snapshot.sessionSnapshot.unreadMessages.filter(
      (message) => nowMs - new Date(message.createdAt).getTime() <= proactivePolicy.activeChatWindowMs,
    ).length
    if (activeChatCount >= proactivePolicy.activeChatMessageThreshold) reasons.push('active_chat')

    const lastSpokeAt = input.snapshot.sessionSnapshot.sceneRecords?.find(
      (record) => record.sceneId === makeSceneId(input.groupId),
    )?.lastSpokeAt
    if (lastSpokeAt && nowMs - new Date(lastSpokeAt).getTime() < proactivePolicy.cooldownMs) reasons.push('cooldown')

    const generationAttempts = (generationAttemptsByGroup.get(input.groupId) ?? []).filter(
      (date) => nowMs - date.getTime() < 60 * 60 * 1000,
    )
    generationAttemptsByGroup.set(input.groupId, generationAttempts)
    if (generationAttempts.length >= proactivePolicy.generationBudgetPerHour) reasons.push('generation_budget')

    const candidateArtifacts = (candidateArtifactsByGroup.get(input.groupId) ?? []).filter(
      (date) => nowMs - date.getTime() < 24 * 60 * 60 * 1000,
    )
    candidateArtifactsByGroup.set(input.groupId, candidateArtifacts)
    if (candidateArtifacts.length >= proactivePolicy.candidateBudgetPerDay) reasons.push('candidate_budget')

    return reasons
  }

  const canCallProactiveJudge = (input: {
    groupId: number
    createdAt: Date
  }): boolean => {
    const nowMs = input.createdAt.getTime()
    const calls = (judgeCallsByGroup.get(input.groupId) ?? []).filter(
      (date) => nowMs - date.getTime() < 60 * 60 * 1000,
    )
    judgeCallsByGroup.set(input.groupId, calls)
    if (calls.length >= proactiveJudgePolicy.maxCallsPerHour) {
      return false
    }
    calls.push(input.createdAt)
    judgeCallsByGroup.set(input.groupId, calls)
    return true
  }

  const persistProactiveJudgeAttempt = async (input: {
    groupId: number
    messageRowId: number
    attemptedAt: Date
  }) => {
    const existing = snapshots.get(input.groupId)
    if (!existing) return

    const attemptedAt = input.attemptedAt.toISOString()
    const judgeAttempts: RuntimeProactiveJudgeAttempt[] = [
      ...(existing.sessionSnapshot.proactiveJudgeAttempts ?? []).filter(
        (attempt) => attempt.messageRowId !== input.messageRowId,
      ),
      { messageRowId: input.messageRowId, attemptedAt },
    ]
    const persisted = await snapshotStore.upsert({
      runtimeKey: existing.runtimeKey,
      groupId: input.groupId,
      schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: existing.contextSnapshot,
      sessionSnapshot: {
        ...existing.sessionSnapshot,
        proactiveJudgeAttempts: judgeAttempts,
      },
      lastObservedMessageRowId: existing.lastObservedMessageRowId,
    })
    snapshots.set(input.groupId, persisted)
  }

  const evaluateProactiveJudge = async (input: {
    message: PersistedGroupMessageIngress
    replyProbability: number
    gateReasons: string[]
    snapshot: RootRuntimeSnapshotRecord
  }) => {
    if (!ambientDecisionEnabled) return undefined
    if (input.replyProbability <= 0) return undefined
    if (input.gateReasons.length > 0) return undefined

    if (!proactiveJudgePolicy.enabled) {
      return createDisabledProactiveJudgeAdvice()
    }
    if (!canCallProactiveJudge({
      groupId: input.message.groupId,
      createdAt: input.message.createdAt,
    })) {
      return createDisabledProactiveJudgeAdvice('proactive judge call budget exhausted')
    }

    try {
      await persistProactiveJudgeAttempt({
        groupId: input.message.groupId,
        messageRowId: input.message.messageRowId,
        attemptedAt: input.message.createdAt,
      })
      return await proactiveJudge.evaluate({
        groupId: input.message.groupId,
        messageRowId: input.message.messageRowId,
        senderId: input.message.senderId,
        senderNickname: input.message.senderNickname,
        segments: input.message.segments,
        recentMessages: buildProactiveJudgeRecentMessages(input.snapshot, input.message.messageRowId),
        createdAt: input.message.createdAt,
        replyProbability: input.replyProbability,
      })
    } catch (error) {
      log.warn({ error, groupId: input.message.groupId }, 'proactive judge failed closed')
      return createInvalidProactiveJudgeAdvice()
    }
  }

  const persistWakeEvent = async (event: RuntimeEvent) => {
    const existing = snapshots.get(event.groupId) ?? {
      ...createDefaultRootRuntimeSnapshot(event.groupId),
      id: 0,
      createdAt: now(),
      updatedAt: now(),
    }

    const persisted = await snapshotStore.upsert({
      runtimeKey: existing.runtimeKey,
      groupId: event.groupId,
      schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: existing.contextSnapshot,
      sessionSnapshot: {
        ...existing.sessionSnapshot,
        lastWakeAt: event.createdAt.toISOString(),
      },
      lastObservedMessageRowId: existing.lastObservedMessageRowId,
    })
    snapshots.set(event.groupId, persisted)
  }

  const persistProactiveGenerationAttempt = async (input: {
    groupId: number
    opportunityId: string
    attemptedAt: Date
  }) => {
    const existing = snapshots.get(input.groupId)
    if (!existing) return

    const attemptedAt = input.attemptedAt.toISOString()
    const generationAttempts = [
      ...(existing.sessionSnapshot.proactiveGenerationAttempts ?? []).filter(
        (attempt) => attempt.opportunityId !== input.opportunityId,
      ),
      { opportunityId: input.opportunityId, attemptedAt },
    ]
    const persisted = await snapshotStore.upsert({
      runtimeKey: existing.runtimeKey,
      groupId: input.groupId,
      schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      contextSnapshot: existing.contextSnapshot,
      sessionSnapshot: {
        ...existing.sessionSnapshot,
        proactiveGenerationAttempts: generationAttempts,
      },
      lastObservedMessageRowId: existing.lastObservedMessageRowId,
    })
    snapshots.set(input.groupId, persisted)

    const bucket = generationAttemptsByGroup.get(input.groupId) ?? []
    bucket.push(input.attemptedAt)
    generationAttemptsByGroup.set(input.groupId, bucket)
  }

  const replyExecutor = options.replyExecutor ?? (replyExecutionEnabled
    ? createReplyExecutor({
        decisionEngine: options.decisionEngine ?? createReplyDecisionEngine({
          ambientAuditEnabled: options.ambientAuditEnabled,
          proactiveJudge: proactiveJudgePolicy,
        }),
        proactiveCandidateStore: { createOrReuse: persistProactiveCandidate },
        onProactiveGenerationAttempt: (opportunity) => persistProactiveGenerationAttempt({
          groupId: opportunity.groupId,
          opportunityId: opportunity.opportunityId,
          attemptedAt: opportunity.createdAt,
        }),
        onReplyRecordSent: options.onReplyRecordSent,
      })
    : null)

  return {
    async restore(groupIds) {
      const restoredSnapshots = await snapshotStore.listByGroupIds(groupIds)
      snapshots.clear()
      let skippedCount = 0

      for (const snapshot of restoredSnapshots) {
        if (snapshot.schemaVersion !== ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION) {
          skippedCount++
          log.warn(
            {
              runtimeKey: snapshot.runtimeKey,
              schemaVersion: snapshot.schemaVersion,
              expectedSchemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
            },
            'Skipping incompatible root runtime snapshot',
          )
          continue
        }
        snapshots.set(snapshot.groupId, snapshot)
        generationAttemptsByGroup.set(
          snapshot.groupId,
          (snapshot.sessionSnapshot.proactiveGenerationAttempts ?? [])
            .map((attempt) => new Date(attempt.attemptedAt))
            .filter((date) => Number.isFinite(date.getTime())),
        )
        candidateArtifactsByGroup.set(
          snapshot.groupId,
          (snapshot.sessionSnapshot.proactiveCandidateArtifacts ?? [])
            .filter((artifact) => artifact.status === 'candidate_generated')
            .map((artifact) => new Date(artifact.createdAt))
            .filter((date) => Number.isFinite(date.getTime())),
        )
        judgeCallsByGroup.set(
          snapshot.groupId,
          (snapshot.sessionSnapshot.proactiveJudgeAttempts ?? [])
            .map((attempt) => new Date(attempt.attemptedAt))
            .filter((date) => Number.isFinite(date.getTime())),
        )
      }

      log.info(
        {
          restoredCount: snapshots.size,
          skippedCount,
          groupIds,
        },
        'root runtime snapshots restored',
      )

      return {
        restoredCount: snapshots.size,
      }
    },

    async emitRuntimeEvent(event, eventOptions = {}) {
      if (event.eventKind === 'group_message') {
        if (!event.message) {
          log.warn({ eventKind: event.eventKind, groupId: event.groupId }, 'runtime event missing group message payload')
          return
        }
        await this.ingestGroupMessage(event.message, eventOptions)
        return
      }

      await persistWakeEvent(event)
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
      const sceneId = makeSceneId(input.groupId)
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

    getSnapshot(groupId) {
      return snapshots.get(groupId) ?? null
    },

    async primeGroupCursor(input) {
      const existing = snapshots.get(input.groupId)
      const current = existing ?? {
        ...createDefaultRootRuntimeSnapshot(input.groupId),
        id: 0,
        createdAt: now(),
        updatedAt: now(),
      }

      const persisted = await snapshotStore.upsert({
        runtimeKey: current.runtimeKey,
        groupId: input.groupId,
        schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
        contextSnapshot: current.contextSnapshot,
        sessionSnapshot: current.sessionSnapshot,
        lastObservedMessageRowId: Math.max(current.lastObservedMessageRowId ?? 0, input.lastObservedMessageRowId),
      })
      snapshots.set(input.groupId, persisted)
    },

    requeuePendingPassiveMentions(groupIds) {
      const targetGroupIds = groupIds ?? [...snapshots.keys()]
      let enqueuedCount = 0

      for (const groupId of targetGroupIds) {
        const snapshot = snapshots.get(groupId)
        if (!snapshot) {
          continue
        }

        const continuityByKey = new Map(
          snapshot.sessionSnapshot.senderContinuities.map((continuity) => [continuity.senderThreadKey, continuity]),
        )
        const pendingCueMessageIds = new Set(
          (snapshot.sessionSnapshot.outstandingCues ?? [])
            .filter((cue) => cue.status === 'pending' && cue.preferredDeliveryMode === 'reply_to_message')
            .map((cue) => cue.messageId),
        )
        const pendingMessages = snapshot.sessionSnapshot.unreadMessages
          .filter((message) => message.mentionedSelf || pendingCueMessageIds.has(message.messageId))
          .filter((message) => {
            const continuity = continuityByKey.get(toSenderThreadKey(message.senderId))
            return message.messageRowId > (continuity?.lastMaterializedMessageRowId ?? 0)
          })
          .sort((left, right) => left.messageRowId - right.messageRowId)

        for (const message of pendingMessages) {
          getMailbox(groupId).addMention({
            groupId,
            messageId: message.messageId,
            messageRowId: message.messageRowId,
            senderId: message.senderId,
            createdAt: new Date(message.createdAt).getTime(),
          })
          enqueuedCount++
        }
      }

      return enqueuedCount
    },

    async markPassiveReplyDelivered(input) {
      const existing = snapshots.get(input.groupId)
      const current = existing ?? {
        ...createDefaultRootRuntimeSnapshot(input.groupId),
        id: 0,
        createdAt: now(),
        updatedAt: now(),
      }
      const senderThreadKey = toSenderThreadKey(input.senderId)
      const updatedAt = now().toISOString()
      const sceneId = makeSceneId(input.groupId)
      const continuityByKey = new Map(
        current.sessionSnapshot.senderContinuities.map((continuity) => [continuity.senderThreadKey, continuity]),
      )
      const existingContinuity = continuityByKey.get(senderThreadKey)
      continuityByKey.set(senderThreadKey, {
        senderThreadKey,
        senderId: input.senderId,
        lastSeenMessageRowId: Math.max(existingContinuity?.lastSeenMessageRowId ?? 0, input.incorporatedMessageRowId),
        lastMaterializedMessageRowId: Math.max(
          existingContinuity?.lastMaterializedMessageRowId ?? 0,
          input.incorporatedMessageRowId,
        ),
        updatedAt,
      })

      const nextSenderContinuities = [...continuityByKey.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, senderContinuityLimit)
      const nextUnreadMessages = current.sessionSnapshot.unreadMessages.filter(
        (message) =>
          !(
            message.senderId === input.senderId &&
            message.messageRowId <= input.incorporatedMessageRowId
          ),
      )
      const nextOutstandingCues = (current.sessionSnapshot.outstandingCues ?? []).map((cue) => {
        if (
          cue.sceneId === sceneId &&
          cue.status === 'pending' &&
          cue.senderId === input.senderId &&
          cue.triggerMessageRowId <= input.incorporatedMessageRowId
        ) {
          return { ...cue, status: 'replied' as const }
        }

        return cue
      })
      const previousSceneRecord = (current.sessionSnapshot.sceneRecords ?? []).find((record) => record.sceneId === sceneId)
      const nextSceneRecords = upsertSceneRecord(
        current.sessionSnapshot.sceneRecords,
        buildSceneRecord({
          groupId: input.groupId,
          previous: previousSceneRecord,
          unreadMessages: nextUnreadMessages,
          lastObservedMessageRowId: current.lastObservedMessageRowId ?? null,
          lastMaterializedReplyRowId: Math.max(previousSceneRecord?.lastMaterializedReplyRowId ?? 0, input.incorporatedMessageRowId),
          outstandingCues: nextOutstandingCues,
          nowIso: updatedAt,
        }),
      )

      const persisted = await snapshotStore.upsert({
        runtimeKey: current.runtimeKey,
        groupId: input.groupId,
        schemaVersion: ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
        contextSnapshot: {
          messages: upsertContextSnapshotMessage(current.contextSnapshot.messages, {
            role: 'model',
            kind: 'assistant_turn',
            orderKey: input.incorporatedMessageRowId,
            senderId: input.senderId,
            content: input.text,
          }),
        },
        sessionSnapshot: {
          ...current.sessionSnapshot,
          focusedTargetId: current.sessionSnapshot.focusedTargetId ?? sceneId,
          unreadMessages: nextUnreadMessages,
          senderContinuities: nextSenderContinuities,
          sceneRecords: nextSceneRecords,
          outstandingCues: nextOutstandingCues,
        },
        lastObservedMessageRowId: current.lastObservedMessageRowId,
      })
      snapshots.set(input.groupId, persisted)
    },

    dispatchPassiveMentionIfMentioned(input) {
      const mentionedSelf = isMentionedSelf(input.segments, options.selfNumber)
      if (!mentionedSelf) {
        return false
      }

      const pendingGroupMentions = pendingMentionHints.get(input.groupId) ?? new Set<number>()
      pendingGroupMentions.add(input.messageId)
      pendingMentionHints.set(input.groupId, pendingGroupMentions)
      return true
    },

    enqueuePassiveMention(event) {
      getMailbox(event.groupId).addMention(event)
    },

    startPassiveExecution() {
      passiveActive = true
      passiveDispatchEnabled = true
      for (const groupId of passiveMailboxes.keys()) {
        runPassiveGroup(groupId)
      }
    },

    stopPassiveExecution() {
      passiveActive = false
      passiveDispatchEnabled = false
      for (const mailbox of passiveMailboxes.values()) {
        mailbox.stop()
      }
      passiveMailboxes.clear()
    },
  }
}

export function getGroupRuntimeKey(groupId: number): string {
  return makeGroupRuntimeKey(groupId)
}
