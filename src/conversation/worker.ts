import { getMessageById } from '../database/messages.js'
import type { Message } from '../generated/prisma/client.js'
import { log } from '../logger.js'
import { messageSender, type MessageSender } from '../messaging/message-sender.js'
import { resolveMessage } from '../media/message-resolver.js'
import type { IncomingMessage } from '../responder/pipeline.js'
import { generateMentionReply } from '../responder/reply-generator.js'
import type { ParsedSegment } from '../types/message-segments.js'
import type { ConversationWorkerResult, GroupConversationBatch, MentionEvent } from './types.js'

type StoredConversationMessage = NonNullable<Awaited<ReturnType<typeof getMessageById>>>

async function defaultGetMessage(groupId: number, messageId: number): Promise<StoredConversationMessage | null> {
  return (await getMessageById(groupId, messageId)) as StoredConversationMessage | null
}

async function defaultResolveSegments(message: StoredConversationMessage): Promise<ParsedSegment[]> {
  return resolveMessage(message as Message)
}

export interface ConversationWorker {
  run(batch: GroupConversationBatch): Promise<ConversationWorkerResult>
}

export interface ConversationWorkerOptions {
  getMessage?: (groupId: number, messageId: number) => Promise<StoredConversationMessage | null>
  resolveSegments?: (message: StoredConversationMessage) => Promise<ParsedSegment[]>
  generateReply?: (message: IncomingMessage) => Promise<string | null>
  sender?: MessageSender
  maxSenderThreadsPerRun?: number
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

function getEarliestEvent(events: MentionEvent[]): MentionEvent {
  return events.reduce((earliest, current) => (current.createdAt < earliest.createdAt ? current : earliest))
}

function getLatestEvent(events: MentionEvent[]): MentionEvent {
  return events.reduce((latest, current) => (current.createdAt > latest.createdAt ? current : latest))
}

async function loadIncomingMessage(
  event: MentionEvent,
  options: Required<Pick<ConversationWorkerOptions, 'getMessage' | 'resolveSegments'>>,
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

export function createConversationWorker(options: ConversationWorkerOptions = {}): ConversationWorker {
  const maxSenderThreadsPerRun = options.maxSenderThreadsPerRun ?? 2
  const getMessage = options.getMessage ?? defaultGetMessage
  const resolveSegments = options.resolveSegments ?? defaultResolveSegments
  const generateReply = options.generateReply ?? generateMentionReply
  const sender = options.sender ?? messageSender

  return {
    async run(batch) {
      const senderThreads = groupEventsBySender(batch.events)
      const activeThreads = senderThreads.slice(0, maxSenderThreadsPerRun)
      const leftoverEvents = senderThreads.slice(maxSenderThreadsPerRun).flatMap((thread) => thread.events)

      for (const thread of activeThreads) {
        const replyTarget = getEarliestEvent(thread.events)
        const latestEvent = getLatestEvent(thread.events)
        const message = await loadIncomingMessage(latestEvent, { getMessage, resolveSegments })

        if (!message) {
          log.warn(
            { groupId: batch.groupId, messageId: latestEvent.messageId, senderId: thread.senderId },
            '异步会话消息不存在，跳过本轮回复',
          )
          continue
        }

        const reply = await generateReply(message)
        if (!reply) {
          log.warn(
            { groupId: batch.groupId, messageId: latestEvent.messageId, senderId: thread.senderId },
            '异步会话未生成正式回复',
          )
          continue
        }

        await sender.replyToMessage({
          groupId: batch.groupId,
          replyToMessageId: replyTarget.messageId,
          mentionUserId: thread.senderId,
          text: reply,
        })
      }

      return { leftoverEvents }
    },
  }
}
