import { getMessageById } from '../database/messages.js'
import type { Message } from '../generated/prisma/client.js'
import type { ConversationWorkerResult, GroupConversationBatch, MentionEvent } from '../conversation/types.js'
import { toSceneReplyScopeKey } from '../conversation/reply-scope.js'
import { compactConversationIfNeeded } from '../conversation/compaction.js'
import { messageSender } from '../messaging/message-sender.js'
import { createLogger } from '../logger.js'
import { resolveMessage } from '../media/message-resolver.js'
import type { ParsedSegment } from '../types/message-segments.js'
import type { IncomingMessage } from '../responder/pipeline.js'
import { createReplyExecutor, type ReplyExecutor, type ReplyExecutorOptions } from './reply-executor.js'
import { makeMentionReplyIntentId, makeMainAgentRuntimeKey, makeSceneId } from './types.js'
import type { ReplyRecord } from '../conversation/reply-record-store.js'

type StoredConversationMessage = NonNullable<Awaited<ReturnType<typeof getMessageById>>>

const log = createLogger('PASSIVE_RUNTIME')

export interface PassiveMentionProcessor {
  run(batch: GroupConversationBatch): Promise<ConversationWorkerResult>
}

export interface PassiveMentionProcessorOptions extends ReplyExecutorOptions {
  maxSenderThreadsPerRun?: number
  getMessage?: (groupId: number, messageId: number) => Promise<StoredConversationMessage | null>
  resolveSegments?: (message: StoredConversationMessage) => Promise<ParsedSegment[]>
  onReplyRecordSent?: (record: ReplyRecord) => Promise<void>
  compactor?: typeof compactConversationIfNeeded
  executor?: ReplyExecutor
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
    messageRowId: stored.id,
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
  const sender = options.sender ?? messageSender
  const compactor = options.compactor ?? compactConversationIfNeeded
  const executor = options.executor ?? createReplyExecutor({
    ...options,
    buildIncomingMessage: async (opportunity) => {
      const event = {
        groupId: opportunity.groupId,
        messageId: opportunity.incorporatedMessageId,
        senderId: opportunity.triggerSenderId,
        createdAt: opportunity.createdAt.getTime(),
      }
      return loadIncomingMessage(event, { getMessage, resolveSegments })
    },
    sender,
  })

  return {
    async run(batch) {
      if (batch.events.length === 0) {
        return { leftoverEvents: [] }
      }

      const senderThreads = groupEventsBySender(batch.events)
      const activeThreads = senderThreads.slice(0, maxSenderThreadsPerRun)
      const leftoverEvents = senderThreads.slice(maxSenderThreadsPerRun).flatMap((thread) => thread.events)
      const deliveryResults: NonNullable<ConversationWorkerResult['deliveryResults']> = []

      for (const thread of activeThreads) {
        const replyTarget = getFirstEvent(thread.events)
        const latestEvent = getLastEvent(thread.events)
        const [replyTargetStored, latestStored] = await Promise.all([
          getMessage(batch.groupId, replyTarget.messageId),
          getMessage(batch.groupId, latestEvent.messageId),
        ])

        if (!replyTargetStored || !latestStored) {
          log.warn(
            { groupId: batch.groupId, messageId: latestEvent.messageId, senderId: thread.senderId },
            '被动 runtime 消息不存在，跳过本轮回复',
          )
          deliveryResults.push('skipped')
          continue
        }

        const sceneId = replyTarget.runtimeSceneId ?? makeSceneId(batch.groupId)
        const scopeKey = toSceneReplyScopeKey(sceneId)
        const runtimeKey = makeMainAgentRuntimeKey()
        const result = await executor.execute({
          opportunityId: replyTarget.runtimeOpportunityId ?? makeMentionReplyIntentId(batch.groupId, replyTargetStored.id),
          decisionId: replyTarget.runtimeDecisionId,
          runtimeKey,
          groupId: batch.groupId,
          sceneId,
          scopeKey,
          sourceKind: 'mention',
          cueStrength: 'strong',
          mustReplyOverride: true,
          replyProbability: 1,
          anchorMessageRowId: replyTargetStored.id,
          triggerMessageRowId: replyTargetStored.id,
          triggerMessageId: Number(replyTargetStored.messageId),
          triggerSenderId: thread.senderId,
          incorporatedMessageRowId: latestStored.id,
          incorporatedMessageId: Number(latestStored.messageId),
          deliveryMode: 'reply_to_message',
          dryRun: sender.isReplyDryRunEnabled?.() ?? false,
          reason: 'direct @self mention batched by passive mailbox',
          createdAt: new Date(latestEvent.createdAt),
        })

        if (result.deliveryResult === 'sent') {
          await compactor(batch.groupId, scopeKey)
        }
        deliveryResults.push(result.deliveryResult ?? 'skipped')
      }

      return { leftoverEvents, deliveryResults }
    },
  }
}
