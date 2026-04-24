import type { ParsedSegment } from '../types/message-segments.js'
import { createLogger } from '../logger.js'
import { createGroupMailbox, type GroupMailbox } from '../conversation/group-mailbox.js'
import { toSenderThreadKey } from '../conversation/thread-key.js'
import type { ConversationWorkerResult, GroupConversationBatch, MentionEvent } from '../conversation/types.js'
import { toSenderReplyScopeKey } from '../conversation/reply-scope.js'
import { createReplyExecutor, type ReplyExecutor } from './reply-executor.js'
import type { ReplyOpportunity } from './reply-decision-types.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
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
  type RuntimeSceneRecord,
  type RuntimeUnreadMessage,
  type RootRuntimeSnapshotRecord,
} from './types.js'
import {
  listRootRuntimeSnapshotsByGroupIds,
  upsertRootRuntimeSnapshot,
} from './snapshot-store.js'

const log = createLogger('ROOT_RUNTIME')
const ROOT_RUNTIME_CONTEXT_MESSAGE_LIMIT = 200
const DEFAULT_AMBIENT_REPLY_BASE_PROBABILITY = 0.02

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

export interface PersistedGroupMessageIngress {
  groupId: number
  messageRowId: number
  messageId: number
  senderId: number
  senderNickname: string
  segments: ParsedSegment[]
  createdAt: Date
}

export interface RootRuntimeManager {
  restore(groupIds: number[]): Promise<{ restoredCount: number }>
  ingestGroupMessage(input: PersistedGroupMessageIngress): Promise<void>
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
  ambientAuditEnabled?: boolean
  ambientReplyBaseProbability?: number
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
  const ambientDecisionEnabled = options.ambientAuditEnabled !== false && Boolean(options.replyExecutor)
  const liveMentionDecisionEnabled = Boolean(options.replyExecutor)
  const ambientReplyBaseProbability = options.ambientReplyBaseProbability ?? DEFAULT_AMBIENT_REPLY_BASE_PROBABILITY
  const replyExecutor = options.replyExecutor ?? createReplyExecutor()
  const snapshotStore = options.snapshotStore ?? {
    listByGroupIds: listRootRuntimeSnapshotsByGroupIds,
    upsert: upsertRootRuntimeSnapshot,
  }
  const snapshots = new Map<number, RootRuntimeSnapshotRecord>()
  const passiveMailboxes = new Map<number, GroupMailbox>()
  const pendingMentionHints = new Map<number, Set<number>>()
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

    async ingestGroupMessage(input) {
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
            replyProbability: 1,
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
            replyProbability: scoreAmbientReplyProbability({
              segments: input.segments,
              baseProbability: ambientReplyBaseProbability,
            }),
            triggerMessageRowId: input.messageRowId,
            triggerMessageId: input.messageId,
            triggerSenderId: input.senderId,
            incorporatedMessageRowId: input.messageRowId,
            incorporatedMessageId: input.messageId,
            deliveryMode: 'audit_only',
            dryRun: true,
            reason: 'ambient group message baseline weak opportunity; audit-only',
            createdAt: input.createdAt,
          }

      if (mentionedSelf && liveMentionDecisionEnabled) {
        await replyExecutor.execute(opportunity)
      } else if (!mentionedSelf && ambientDecisionEnabled) {
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
