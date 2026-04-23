import type { ParsedSegment } from '../types/message-segments.js'
import { createLogger } from '../logger.js'
import { createGroupMailbox, type GroupMailbox } from '../conversation/group-mailbox.js'
import { toSenderThreadKey } from '../conversation/thread-key.js'
import type { ConversationWorkerResult, GroupConversationBatch, MentionEvent } from '../conversation/types.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import {
  createDefaultRootRuntimeSnapshot,
  DEFAULT_ROOT_RUNTIME_SENDER_CONTINUITY_LIMIT,
  DEFAULT_ROOT_RUNTIME_UNREAD_LIMIT,
  makeGroupRuntimeKey,
  ROOT_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  type CreateRootRuntimeSnapshotInput,
  type RuntimeContextMessage,
  type RuntimeUnreadMessage,
  type RootRuntimeSnapshotRecord,
} from './types.js'
import {
  listRootRuntimeSnapshotsByGroupIds,
  upsertRootRuntimeSnapshot,
} from './snapshot-store.js'

const log = createLogger('ROOT_RUNTIME')
const ROOT_RUNTIME_CONTEXT_MESSAGE_LIMIT = 200

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

export function createRootRuntimeManager(options: RootRuntimeManagerOptions): RootRuntimeManager {
  const unreadLimit = options.unreadLimit ?? DEFAULT_ROOT_RUNTIME_UNREAD_LIMIT
  const senderContinuityLimit = options.senderContinuityLimit ?? DEFAULT_ROOT_RUNTIME_SENDER_CONTINUITY_LIMIT
  const passiveMergeWindowMs = options.passiveMergeWindowMs ?? 1_000
  const now = options.now ?? (() => new Date())
  const snapshotStore = options.snapshotStore ?? {
    listByGroupIds: listRootRuntimeSnapshotsByGroupIds,
    upsert: upsertRootRuntimeSnapshot,
  }
  const snapshots = new Map<number, RootRuntimeSnapshotRecord>()
  const passiveMailboxes = new Map<number, GroupMailbox>()
  let passiveActive = false

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
      const senderThreadKey = toSenderThreadKey(input.senderId)
      const updatedAt = input.createdAt.toISOString()
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
          unreadMessages: nextUnreadMessages,
          senderContinuities: nextSenderContinuities,
          recentObservedMessageRowIds: nextRecentObservedMessageRowIds,
        },
        lastObservedMessageRowId: Math.max(currentLastObserved, input.messageRowId),
      }

      const persisted = await snapshotStore.upsert(nextSnapshotInput)
      snapshots.set(input.groupId, persisted)
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
          senderContinuities: nextSenderContinuities,
        },
        lastObservedMessageRowId: current.lastObservedMessageRowId,
      })
      snapshots.set(input.groupId, persisted)
    },

    dispatchPassiveMentionIfMentioned(input) {
      if (!isMentionedSelf(input.segments, options.selfNumber)) {
        return false
      }

      getMailbox(input.groupId).addMention({
        groupId: input.groupId,
        messageId: input.messageId,
        senderId: input.senderId,
        createdAt: input.createdAt,
      })
      return true
    },

    enqueuePassiveMention(event) {
      getMailbox(event.groupId).addMention(event)
    },

    startPassiveExecution() {
      passiveActive = true
      for (const groupId of passiveMailboxes.keys()) {
        runPassiveGroup(groupId)
      }
    },

    stopPassiveExecution() {
      passiveActive = false
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
