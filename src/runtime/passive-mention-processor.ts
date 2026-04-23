import { getMessageById } from '../database/messages.js'
import type { Message } from '../generated/prisma/client.js'
import { createLogger } from '../logger.js'
import { messageSender, type MessageSender } from '../messaging/message-sender.js'
import { resolveMessage } from '../media/message-resolver.js'
import type { IncomingMessage } from '../responder/pipeline.js'
import { generateMentionReply } from '../responder/reply-generator.js'
import type { ParsedSegment } from '../types/message-segments.js'
import type { ConversationWorkerResult, GroupConversationBatch, MentionEvent } from '../conversation/types.js'
import { toSenderThreadKey } from '../conversation/thread-key.js'
import {
  createOrReusePendingAssistantTurn,
  findAssistantTurnByReplyIntentId,
  markAssistantTurnFailed,
  markAssistantTurnSending,
  markAssistantTurnSent,
  type AssistantTurnRecord,
} from '../conversation/assistant-turn-store.js'
import { deliverAssistantTurn } from '../conversation/assistant-turn-delivery.js'
import { compactConversationIfNeeded } from '../conversation/compaction.js'
import { updateConversationStateLastIncorporated } from '../conversation/conversation-state-store.js'

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
  assistantTurnStore?: {
    findByReplyIntentId: typeof findAssistantTurnByReplyIntentId
    createOrReusePending: typeof createOrReusePendingAssistantTurn
    markSending: typeof markAssistantTurnSending
    markSent: typeof markAssistantTurnSent
    markFailed: typeof markAssistantTurnFailed
  }
  conversationStateStore?: {
    updateLastIncorporated: typeof updateConversationStateLastIncorporated
  }
  compactor?: typeof compactConversationIfNeeded
  maxSenderThreadsPerRun?: number
  onAssistantTurnSent?: (turn: AssistantTurnRecord) => Promise<void> | void
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
  const assistantTurnStore = options.assistantTurnStore ?? {
    findByReplyIntentId: findAssistantTurnByReplyIntentId,
    createOrReusePending: createOrReusePendingAssistantTurn,
    markSending: markAssistantTurnSending,
    markSent: markAssistantTurnSent,
    markFailed: markAssistantTurnFailed,
  }
  const conversationStateStore = options.conversationStateStore ?? {
    updateLastIncorporated: updateConversationStateLastIncorporated,
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

        const senderThreadKey = toSenderThreadKey(thread.senderId)
        const replyIntentId = `${batch.groupId}:${senderThreadKey}:${replyTargetStored.id}:${latestStored.id}`
        const existingTurn = await assistantTurnStore.findByReplyIntentId(batch.groupId, senderThreadKey, replyIntentId)
        const reply = existingTurn?.text ?? await generateReply(message)
        if (!reply) {
          log.warn(
            { groupId: batch.groupId, messageId: latestEvent.messageId, senderId: thread.senderId },
            '被动 runtime 未生成正式回复',
          )
          continue
        }

        const assistantTurn = await assistantTurnStore.createOrReusePending({
          groupId: batch.groupId,
          senderThreadKey,
          replyIntentId,
          triggerMessageRowId: replyTargetStored.id,
          incorporatedMessageRowId: latestStored.id,
          replyToMessageId: Number(replyTargetStored.messageId),
          mentionUserId: thread.senderId,
          text: reply,
        })

        if (assistantTurn.status === 'sent') {
          continue
        }

        const deliveryResult = await deliverAssistantTurn(assistantTurn, {
          sender,
          assistantTurnStore,
          conversationStateStore,
          compactor,
        })
        if (deliveryResult === 'sent') {
          await options.onAssistantTurnSent?.(assistantTurn)
        }
      }

      return { leftoverEvents }
    },
  }
}
