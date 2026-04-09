import { createLogger } from '../logger.js'
import { createGroupMailbox, type GroupMailbox } from './group-mailbox.js'
import type { ConversationWorkerResult, GroupConversationBatch, MentionEvent } from './types.js'

const log = createLogger('CONV_SCHED')

export interface ConversationSchedulerOptions {
  mergeWindowMs: number
  proactiveDebounceMs?: number
  proactiveMaxWaitMs?: number
  worker: (batch: GroupConversationBatch) => Promise<ConversationWorkerResult | void>
}

export interface ConversationScheduler {
  onMention(event: MentionEvent): void
  /** 记录一条普通消息（用于 proactive 评估） */
  onMessage(groupId: number): void
  stop(): void
}

export function createConversationScheduler(options: ConversationSchedulerOptions): ConversationScheduler {
  const mailboxes = new Map<number, GroupMailbox>()

  const createBatch = (groupId: number, events: MentionEvent[]): GroupConversationBatch => ({
    groupId,
    events,
    messagesSinceLastEval: 0,
    openedAt: events[0]?.createdAt ?? Date.now(),
    closedAt: events[events.length - 1]?.createdAt ?? Date.now(),
  })

  const runIfIdle = (groupId: number) => {
    const mailbox = mailboxes.get(groupId)
    if (!mailbox) return

    const batch = mailbox.claimNextBatch()
    if (!batch) return

    void options.worker(batch)
      .then((result) => {
        if (result?.leftoverEvents.length) {
          mailbox.enqueueBatch(createBatch(groupId, result.leftoverEvents))
        }
      })
      .catch((error) => {
        log.error({ error, groupId, batch }, '异步会话任务执行失败')
      })
      .finally(() => {
        mailbox.finishCurrentRun()
        runIfIdle(groupId)
      })
  }

  const getMailbox = (groupId: number) => {
    const existing = mailboxes.get(groupId)
    if (existing) return existing

    const mailbox = createGroupMailbox({
      groupId,
      mergeWindowMs: options.mergeWindowMs,
      proactiveDebounceMs: options.proactiveDebounceMs,
      proactiveMaxWaitMs: options.proactiveMaxWaitMs,
      onBatchReady: () => {
        runIfIdle(groupId)
      },
    })
    mailboxes.set(groupId, mailbox)
    return mailbox
  }

  return {
    onMention(event) {
      const mailbox = getMailbox(event.groupId)
      mailbox.addMention(event)
    },

    onMessage(groupId) {
      const mailbox = getMailbox(groupId)
      mailbox.addMessage()
    },

    stop() {
      for (const mailbox of mailboxes.values()) {
        mailbox.stop()
      }
      mailboxes.clear()
    },
  }
}
