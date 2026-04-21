import type { GroupConversationBatch, MentionEvent } from './types.js'

type TimerHandle = ReturnType<typeof setTimeout>

export interface GroupMailboxOptions {
  groupId: number
  mergeWindowMs: number
  onBatchReady?: (batch: GroupConversationBatch) => void
  schedule?: (callback: () => void, delayMs: number) => TimerHandle
  clearSchedule?: (timer: TimerHandle) => void
}

export interface GroupMailboxSnapshot {
  groupId: number
  pendingEvents: MentionEvent[]
  readyBatches: GroupConversationBatch[]
  windowOpen: boolean
  running: boolean
}

export interface GroupMailbox {
  addMention(event: MentionEvent): void
  enqueueBatch(batch: GroupConversationBatch): void
  claimNextBatch(): GroupConversationBatch | undefined
  finishCurrentRun(): void
  stop(): void
  snapshot(): GroupMailboxSnapshot
}

export function createGroupMailbox(options: GroupMailboxOptions): GroupMailbox {
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearSchedule = options.clearSchedule ?? ((timer) => clearTimeout(timer))

  // --- mention state ---
  let pendingEvents: MentionEvent[] = []
  let windowOpenedAt: number | null = null
  let mentionTimer: TimerHandle | undefined

  // --- shared state ---
  let readyBatches: GroupConversationBatch[] = []
  let running = false

  const closeMentionWindow = () => {
    mentionTimer = undefined
    if (pendingEvents.length === 0 || windowOpenedAt === null) return

    const batch: GroupConversationBatch = {
      groupId: options.groupId,
      events: pendingEvents,
      openedAt: windowOpenedAt,
      closedAt: pendingEvents[pendingEvents.length - 1]?.createdAt ?? windowOpenedAt,
    }

    pendingEvents = []
    windowOpenedAt = null
    readyBatches.push(batch)
    options.onBatchReady?.(batch)
  }

  return {
    addMention(event) {
      pendingEvents.push(event)
      if (windowOpenedAt === null) {
        windowOpenedAt = event.createdAt
        mentionTimer = schedule(closeMentionWindow, options.mergeWindowMs)
      }
    },

    enqueueBatch(batch) {
      readyBatches.push(batch)
      options.onBatchReady?.(batch)
    },

    claimNextBatch() {
      if (running) return undefined
      const next = readyBatches.shift()
      if (!next) return undefined
      running = true
      return next
    },

    finishCurrentRun() {
      running = false
    },

    stop() {
      if (mentionTimer) {
        clearSchedule(mentionTimer)
        mentionTimer = undefined
      }
      pendingEvents = []
      readyBatches = []
      windowOpenedAt = null
      running = false
    },

    snapshot() {
      return {
        groupId: options.groupId,
        pendingEvents: [...pendingEvents],
        readyBatches: [...readyBatches],
        windowOpen: windowOpenedAt !== null,
        running,
      }
    },
  }
}
