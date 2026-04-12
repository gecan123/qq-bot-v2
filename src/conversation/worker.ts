import { getMessageById } from '../database/messages.js'
import type { Message } from '../generated/prisma/client.js'
import { createLogger } from '../logger.js'
import { messageSender, type MessageSender } from '../messaging/message-sender.js'
import { resolveMessage } from '../media/message-resolver.js'
import type { IncomingMessage } from '../responder/pipeline.js'
import { generateMentionReply } from '../responder/reply-generator.js'
import type { ParsedSegment } from '../types/message-segments.js'
import type { ConversationWorkerResult, GroupConversationBatch, MentionEvent } from './types.js'

type StoredConversationMessage = NonNullable<Awaited<ReturnType<typeof getMessageById>>>
const log = createLogger('CONV_WORKER')

async function defaultGetMessage(groupId: number, messageId: number): Promise<StoredConversationMessage | null> {
  return (await getMessageById(groupId, messageId)) as StoredConversationMessage | null
}

async function defaultResolveSegments(message: StoredConversationMessage): Promise<ParsedSegment[]> {
  return resolveMessage(message as Message, { timeoutMs: 0 })
}

export interface ProactiveHandler {
  /** 评估并可能执行主动回复。返回 true 表示已发送消息 */
  evaluate(groupId: number, messagesSinceLastEval: number): Promise<boolean>
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
  proactiveHandler?: ProactiveHandler
  /** 调用时机：bot 消息实际发送成功后 */
  onBotReplySent?: (groupId: number) => void
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
      // --- mention 优先处理 ---
      if (batch.events.length > 0) {
        return runMentionBatch(batch)
      }

      // --- proactive 评估 ---
      if (batch.messagesSinceLastEval > 0 && options.proactiveHandler) {
        try {
          const sent = await options.proactiveHandler.evaluate(batch.groupId, batch.messagesSinceLastEval)
          if (sent) {
            options.onBotReplySent?.(batch.groupId)
          }
        } catch (error) {
          log.error({ error, groupId: batch.groupId }, '主动回复评估失败')
        }
      }

      return { leftoverEvents: [] }
    },
  }

  async function runMentionBatch(batch: GroupConversationBatch): Promise<ConversationWorkerResult> {
    const senderThreads = groupEventsBySender(batch.events)
    const activeThreads = senderThreads.slice(0, maxSenderThreadsPerRun)
    const leftoverEvents = senderThreads.slice(maxSenderThreadsPerRun).flatMap((thread) => thread.events)

    for (const thread of activeThreads) {
      const replyTarget = getFirstEvent(thread.events)
      const latestEvent = getLastEvent(thread.events)
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

      options.onBotReplySent?.(batch.groupId)
    }

    return { leftoverEvents }
  }
}
