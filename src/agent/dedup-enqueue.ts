import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'

/**
 * 包装 EventQueue.enqueue, 对带 messageRowId 的消息事件按 rowId 去重.
 *
 * 为什么需要: D2 把 napcat.connect() 排在 replayMissedMessages 之前, 中间窗口里
 * NapCat 收到的实时消息会同时:
 *   1. 经 onMessageReady → 这个 enqueue → 入队
 *   2. 落库 → 后续 replay-missed 的 findMany 也看到 → 试图再入队
 * 不去重 → 同一条消息在 LLM 视野里出现两次, 浪费 token + 让 prompt cache 路径混乱.
 *
 * 控制事件 (wake) 不去重 (没有 messageRowId 字段).
 *
 * 返回 false 表示去重命中, 没有真入队. 调用方可以据此统计.
 */
export interface DedupEnqueue {
  (event: BotEvent): boolean
  /** 测试用: 暴露当前已入队的 rowId 集合大小. */
  readonly seenCount: () => number
}

export function createDedupEnqueue(queue: EventQueue<BotEvent>): DedupEnqueue {
  const seenMessageRowIds = new Set<number>()
  const fn = ((event: BotEvent): boolean => {
    if (event.type === 'napcat_message' || event.type === 'napcat_private_message') {
      if (seenMessageRowIds.has(event.messageRowId)) return false
      seenMessageRowIds.add(event.messageRowId)
    }
    queue.enqueue(event)
    return true
  }) as DedupEnqueue
  Object.defineProperty(fn, 'seenCount', {
    value: () => seenMessageRowIds.size,
    writable: false,
  })
  return fn
}
