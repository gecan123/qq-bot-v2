import { log } from '../logger.js'
import { createGroupMailbox, type GroupMailbox } from './group-mailbox.js'
import type { ConversationWorkerResult, GroupConversationBatch, MentionEvent } from './types.js'

export interface ConversationSchedulerOptions {
  mergeWindowMs: number
  worker: (batch: GroupConversationBatch) => Promise<ConversationWorkerResult | void>
}

export interface ConversationScheduler {
  onMention(event: MentionEvent): void
  stop(): void
}

export function createConversationScheduler(options: ConversationSchedulerOptions): ConversationScheduler {
  const mailboxes = new Map<number, GroupMailbox>()

  const createBatch = (groupId: number, events: MentionEvent[]): GroupConversationBatch => ({
    groupId,
    events,
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

    stop() {
      for (const mailbox of mailboxes.values()) {
        mailbox.stop()
      }
      mailboxes.clear()
    },
  }
}
