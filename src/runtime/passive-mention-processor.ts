import { getMessageById } from '../database/messages.js'
import type { Message } from '../generated/prisma/client.js'
import { createLogger } from '../logger.js'
import { messageSender, type MessageSender } from '../messaging/message-sender.js'
import { resolveMessage } from '../media/message-resolver.js'
import type { IncomingMessage } from '../responder/pipeline.js'
import { generateMentionReply } from '../responder/reply-generator.js'
import type { ParsedSegment } from '../types/message-segments.js'
import type { ConversationWorkerResult, GroupConversationBatch, MentionEvent } from '../conversation/types.js'
import { toSenderReplyScopeKey } from '../conversation/reply-scope.js'
import {
  createOrReuseReplyRecord,
  findReplyRecordByReplyIntentId,
  markReplyRecordAcked,
  markReplyRecordFailed,
  markReplyRecordSending,
  markReplyRecordSent,
  type ReplyRecord,
} from '../conversation/reply-record-store.js'
import { createReplyAudit } from '../conversation/reply-audit-store.js'
import { deliverReplyRecord } from '../conversation/reply-record-delivery.js'
import { compactConversationIfNeeded } from '../conversation/compaction.js'
import { makeGroupRuntimeKey, makeMentionReplyIntentId } from './types.js'

type StoredConversationMessage = NonNullable<Awaited<ReturnType<typeof getMessageById>>>
const log = createLogger('PASSIVE_RUNTIME')

export interface PassiveMentionProcessor {
  run(batch: GroupConversationBatch): Promise<ConversationWorkerResult>
}

export interface PassiveMentionProcessorOptions {
  getMessage?: (groupId: number, messageId: number) => Promise<StoredConversationMessage | null>
  resolveSegments?: (message: StoredConversationMessage) => Promise<ParsedSegment[]>
  generateReply?: (message: IncomingMessage) => Promise<string | null>
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
    create: typeof createReplyAudit
  }
  compactor?: typeof compactConversationIfNeeded
  maxSenderThreadsPerRun?: number
  onReplyRecordSent?: (record: ReplyRecord) => Promise<void> | void
}

interface SenderThread {
  senderId: number
  events: MentionEvent[]
}

function groupEventsBySender(events: MentionEvent[]): SenderThread[] {
  const threads = new Map<number, SenderThread>()

  for (const event of events) {
    const existing = threads.get(event.senderId)
    if (existing) {
      existing.events.push(event)
      continue
    }

    threads.set(event.senderId, {
      senderId: event.senderId,
      events: [event],
    })
  }

  return [...threads.values()]
}

function getFirstEvent(events: MentionEvent[]): MentionEvent {
  return events[0] as MentionEvent
}

function getLastEvent(events: MentionEvent[]): MentionEvent {
  return events[events.length - 1] as MentionEvent
}

function makeLegacyMentionReplyIntentId(
  runtimeKey: string,
  scopeKey: string,
  triggerMessageRowId: number,
  incorporatedMessageRowId: number,
): string {
  return `${runtimeKey}:${scopeKey}:${triggerMessageRowId}:${incorporatedMessageRowId}`
}

async function loadIncomingMessage(
  event: MentionEvent,
  options: Required<Pick<PassiveMentionProcessorOptions, 'getMessage' | 'resolveSegments'>>,
): Promise<IncomingMessage | null> {
  const stored = await options.getMessage(event.groupId, event.messageId)
  if (!stored) return null

  const segments = await options.resolveSegments(stored)

  return {
    groupId: Number(stored.groupId),
    groupName: stored.groupName ?? undefined,
    messageId: Number(stored.messageId),
    senderId: Number(stored.senderId),
    senderNickname: stored.senderGroupNickname ?? stored.senderNickname ?? String(stored.senderId),
    segments,
  }
}

async function defaultGetMessage(groupId: number, messageId: number): Promise<StoredConversationMessage | null> {
  return (await getMessageById(groupId, messageId)) as StoredConversationMessage | null
}

async function defaultResolveSegments(message: StoredConversationMessage): Promise<ParsedSegment[]> {
  return resolveMessage(message as Message, { timeoutMs: 0 })
}

export function createPassiveMentionProcessor(
  options: PassiveMentionProcessorOptions = {},
): PassiveMentionProcessor {
  const maxSenderThreadsPerRun = options.maxSenderThreadsPerRun ?? 2
  const getMessage = options.getMessage ?? defaultGetMessage
  const resolveSegments = options.resolveSegments ?? defaultResolveSegments
  const generateReply = options.generateReply ?? generateMentionReply
  const sender = options.sender ?? messageSender
  const replyRecordStore = options.replyRecordStore ?? {
    findByReplyIntentId: findReplyRecordByReplyIntentId,
    createOrReuse: createOrReuseReplyRecord,
    markAcked: markReplyRecordAcked,
    markSending: markReplyRecordSending,
    markSent: markReplyRecordSent,
    markFailed: markReplyRecordFailed,
  }
  const replyAuditStore = options.replyAuditStore ?? {
    create: createReplyAudit,
  }
  const compactor = options.compactor ?? compactConversationIfNeeded

  return {
    async run(batch) {
      if (batch.events.length === 0) {
        return { leftoverEvents: [] }
      }

      const senderThreads = groupEventsBySender(batch.events)
      const activeThreads = senderThreads.slice(0, maxSenderThreadsPerRun)
      const leftoverEvents = senderThreads.slice(maxSenderThreadsPerRun).flatMap((thread) => thread.events)

      for (const thread of activeThreads) {
        const replyTarget = getFirstEvent(thread.events)
        const latestEvent = getLastEvent(thread.events)
        const [replyTargetStored, latestStored] = await Promise.all([
          getMessage(batch.groupId, replyTarget.messageId),
          getMessage(batch.groupId, latestEvent.messageId),
        ])
        const message = latestStored
          ? await loadIncomingMessage(latestEvent, {
              getMessage: async () => latestStored,
              resolveSegments,
            })
          : null

        if (!message || !replyTargetStored || !latestStored) {
          log.warn(
            { groupId: batch.groupId, messageId: latestEvent.messageId, senderId: thread.senderId },
            '被动 runtime 消息不存在，跳过本轮回复',
          )
          continue
        }

        const scopeKey = toSenderReplyScopeKey(thread.senderId)
        const runtimeKey = makeGroupRuntimeKey(batch.groupId)
        const replyIntentId = makeMentionReplyIntentId(batch.groupId, replyTargetStored.id)
        const legacyReplyIntentId = makeLegacyMentionReplyIntentId(
          runtimeKey,
          scopeKey,
          replyTargetStored.id,
          latestStored.id,
        )
        const existingRecord =
          (await replyRecordStore.findByReplyIntentId(runtimeKey, replyIntentId)) ??
          (legacyReplyIntentId === replyIntentId
            ? null
            : await replyRecordStore.findByReplyIntentId(runtimeKey, legacyReplyIntentId))
        const reply = existingRecord?.text ?? await generateReply(message)
        if (!reply) {
          log.warn(
            { groupId: batch.groupId, messageId: latestEvent.messageId, senderId: thread.senderId },
            '被动 runtime 未生成正式回复',
          )
          continue
        }

        const shouldDryRun = sender.isReplyDryRunEnabled?.() ?? false
        const replyRecord = await replyRecordStore.createOrReuse({
          runtimeKey,
          groupId: batch.groupId,
          scopeKey,
          replyIntentId: existingRecord?.replyIntentId ?? replyIntentId,
          sourceKind: 'mention',
          triggerMessageRowId: replyTargetStored.id,
          incorporatedMessageRowId: latestStored.id,
          deliveryPayload: {
            type: 'reply_to_message',
            replyToMessageId: Number(replyTargetStored.messageId),
            mentionUserId: thread.senderId,
          },
          text: reply,
          executionState: shouldDryRun ? 'dry_run' : 'pending',
        })

        if (replyRecord.executionState === 'sent') {
          await options.onReplyRecordSent?.(replyRecord)
          continue
        }

        if (replyRecord.executionState === 'dry_run') {
          await replyAuditStore.create({
            replyRecordId: replyRecord.id,
            runtimeKey: replyRecord.runtimeKey,
            groupId: replyRecord.groupId,
            scopeKey: replyRecord.scopeKey,
            replyIntentId: replyRecord.replyIntentId,
            auditKind: 'dry_run_intent',
            payload: {
              sourceKind: replyRecord.sourceKind,
              deliveryType: replyRecord.deliveryPayload.type,
              text: replyRecord.text,
            },
          })
          continue
        }

        const deliveryResult = await deliverReplyRecord(replyRecord, {
          sender,
          replyRecordStore,
          replyAuditStore,
        })
        if (deliveryResult === 'sent') {
          await compactor(batch.groupId, scopeKey)
          await options.onReplyRecordSent?.(replyRecord)
        }
      }

      return { leftoverEvents }
    },
  }
}
