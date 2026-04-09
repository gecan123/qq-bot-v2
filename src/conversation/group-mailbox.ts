import type { GroupConversationBatch, MentionEvent } from './types.js'

type TimerHandle = ReturnType<typeof setTimeout>

export interface GroupMailboxOptions {
  groupId: number
  mergeWindowMs: number
  /** proactive debounce 间隔（ms）；每条普通消息重置此定时器 */
  proactiveDebounceMs?: number
  /** 持续热聊时强制触发的上限（ms） */
  proactiveMaxWaitMs?: number
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
  messagesSinceLastEval: number
}

export interface GroupMailbox {
  addMention(event: MentionEvent): void
  /** 记录一条普通消息（非 bot 自身），启动/重置 proactive debounce */
  addMessage(): void
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

  // --- proactive state ---
  let messagesSinceLastEval = 0
  let proactiveDebounceTimer: TimerHandle | undefined
  let proactiveMaxWaitTimer: TimerHandle | undefined

  // --- shared state ---
  let readyBatches: GroupConversationBatch[] = []
  let running = false

  const closeMentionWindow = () => {
    mentionTimer = undefined
    if (pendingEvents.length === 0 || windowOpenedAt === null) return

    const batch: GroupConversationBatch = {
      groupId: options.groupId,
      events: pendingEvents,
      messagesSinceLastEval: 0,
      openedAt: windowOpenedAt,
      closedAt: pendingEvents[pendingEvents.length - 1]?.createdAt ?? windowOpenedAt,
    }

    pendingEvents = []
    windowOpenedAt = null
    readyBatches.push(batch)
    options.onBatchReady?.(batch)
  }

  const flushProactive = () => {
    clearProactiveTimers()
    if (messagesSinceLastEval === 0) return

    const now = Date.now()
    const batch: GroupConversationBatch = {
      groupId: options.groupId,
      events: [],
      messagesSinceLastEval,
      openedAt: now,
      closedAt: now,
    }

    messagesSinceLastEval = 0
    readyBatches.push(batch)
    options.onBatchReady?.(batch)
  }

  const clearProactiveTimers = () => {
    if (proactiveDebounceTimer) {
      clearSchedule(proactiveDebounceTimer)
      proactiveDebounceTimer = undefined
    }
    if (proactiveMaxWaitTimer) {
      clearSchedule(proactiveMaxWaitTimer)
      proactiveMaxWaitTimer = undefined
    }
  }

  return {
    addMention(event) {
      pendingEvents.push(event)
      if (windowOpenedAt === null) {
        windowOpenedAt = event.createdAt
        mentionTimer = schedule(closeMentionWindow, options.mergeWindowMs)
      }
    },

    addMessage() {
      if (!options.proactiveDebounceMs) return

      messagesSinceLastEval++

      // 重置 debounce timer
      if (proactiveDebounceTimer) {
        clearSchedule(proactiveDebounceTimer)
      }
      proactiveDebounceTimer = schedule(flushProactive, options.proactiveDebounceMs)

      // 首条消息时启动 maxWait timer（不重置）
      if (!proactiveMaxWaitTimer && options.proactiveMaxWaitMs) {
        proactiveMaxWaitTimer = schedule(flushProactive, options.proactiveMaxWaitMs)
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
      clearProactiveTimers()
      pendingEvents = []
      readyBatches = []
      windowOpenedAt = null
      messagesSinceLastEval = 0
      running = false
    },

    snapshot() {
      return {
        groupId: options.groupId,
        pendingEvents: [...pendingEvents],
        readyBatches: [...readyBatches],
        windowOpen: windowOpenedAt !== null,
        running,
        messagesSinceLastEval,
      }
    },
  }
}
