/**
 * EventQueue: BotLoopAgent 在事件之间用来「休息」的核心原语。
 *
 * 三件事:
 *  - enqueue(event): 非阻塞 push。唤醒所有正在 waitForEvent 的 consumer。
 *  - dequeue():       非阻塞 pop。空时返回 null。
 *  - waitForEvent():  阻塞,直到队列从空变非空 (不消费事件)。
 *
 * 关键洞察 (Kagami 同形): timer 不是独立通道, 它就是另一种 producer——
 * setInterval(() => queue.enqueue({type:'wake'}), N)。 真消息和 timer wake 在
 * 同一队列里, consumer 区分不出, 也不必区分。
 */
export interface EventQueue<TEvent> {
  enqueue(event: TEvent): number
  dequeue(): TEvent | null
  size(): number
  clear(): number
  waitForEvent(): Promise<void>
}

export class InMemoryEventQueue<TEvent> implements EventQueue<TEvent> {
  private readonly events: TEvent[] = []
  private readonly waiters: Array<() => void> = []

  enqueue(event: TEvent): number {
    this.events.push(event)
    const toWake = this.waiters.splice(0)
    for (const wake of toWake) {
      wake()
    }
    return this.events.length
  }

  dequeue(): TEvent | null {
    return this.events.shift() ?? null
  }

  size(): number {
    return this.events.length
  }

  clear(): number {
    const cleared = this.events.length
    this.events.length = 0
    return cleared
  }

  waitForEvent(): Promise<void> {
    if (this.events.length > 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }
}
