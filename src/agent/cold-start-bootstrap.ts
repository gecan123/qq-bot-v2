import type { BotEvent } from './event.js'
import type { EventQueue } from './event-queue.js'

/**
 * 无持久 snapshot 的首次启动需要一个受控事实来建立 AgentContext 和 snapshot。
 * 启动期间已经收到实时事件时不额外注入，避免 bootstrap 抢在真实消息前面。
 */
export function enqueueColdStartBootstrap(
  eventQueue: EventQueue<BotEvent>,
  hasPersistedSnapshot: boolean,
): boolean {
  if (hasPersistedSnapshot || eventQueue.size() > 0) return false
  eventQueue.enqueue({ type: 'bootstrap' })
  return true
}
