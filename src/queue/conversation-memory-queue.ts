import { createLogger } from '../logger.js'
import type { MentionEvent } from '../conversation/types.js'
import type { ConversationQueue } from './conversation-queue.js'

type TimerHandle = ReturnType<typeof setTimeout>
const log = createLogger('CONV_QUEUE')

export interface ConversationMemoryQueueOptions {
  onMention: (event: MentionEvent) => Promise<void> | void
}

export function createConversationMemoryQueue(
  options: ConversationMemoryQueueOptions,
): ConversationQueue {
  const queue: MentionEvent[] = []
  let timer: TimerHandle | undefined
  let running = false
  let processing = false

  const schedule = () => {
    if (!running || processing || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void tick()
    }, 0)
  }

  const tick = async () => {
    if (!running || processing) return

    const event = queue.shift()
    if (!event) return

    processing = true
    try {
      await options.onMention(event)
    } finally {
      processing = false
      if (queue.length > 0) schedule()
    }
  }

  return {
    enqueueMention(event) {
      queue.push(event)
      log.debug({ groupId: event.groupId, messageId: event.messageId }, 'mention事件已入异步队列')
      schedule()
    },

    start() {
      if (running) return
      running = true
      schedule()
    },

    stop() {
      running = false
      processing = false
      queue.length = 0
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
