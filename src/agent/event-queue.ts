/**
 * EventQueue: BotLoopAgent 在事件之间用来「休息」的核心原语。
 *
 * 三件事:
 *  - enqueue(event): 非阻塞 push。唤醒所有正在 waitForEvent 的 consumer。
 *  - dequeue():       非阻塞 pop。空时返回 null。
 *  - waitForEvent():  阻塞,直到队列从空变非空 (不消费事件)。
 *  - waitForEventWhere(predicate): 阻塞,直到队列里存在匹配事件 (不消费事件)。
 *
 * 关键洞察 (Kagami 同形): timer 不是独立通道, 它就是另一种 producer——
 * setInterval(() => queue.enqueue({type:'wake'}), N)。 真消息和 timer wake 在
 * 同一队列里, consumer 区分不出, 也不必区分。
 */
export interface EventWaitOptions {
  signal?: AbortSignal
}

export interface EventQueue<TEvent> {
  enqueue(event: TEvent): number
  dequeue(): TEvent | null
  size(): number
  clear(): number
  waitForEvent(options?: EventWaitOptions): Promise<void>
  waitForEventWhere(predicate: (event: TEvent) => boolean, options?: EventWaitOptions): Promise<void>
}

export class InMemoryEventQueue<TEvent> implements EventQueue<TEvent> {
  private readonly events: TEvent[] = []
  private readonly waiters: Array<{
    predicate: (events: TEvent[]) => boolean
    resolve: () => void
  }> = []

  enqueue(event: TEvent): number {
    this.events.push(event)
    const pending = this.waiters.splice(0)
    const remaining: typeof this.waiters = []
    for (const waiter of pending) {
      if (waiter.predicate(this.events)) {
        waiter.resolve()
      } else {
        remaining.push(waiter)
      }
    }
    this.waiters.push(...remaining)
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

  waitForEvent(options: EventWaitOptions = {}): Promise<void> {
    return this.waitForEvents((events) => events.length > 0, options)
  }

  waitForEventWhere(predicate: (event: TEvent) => boolean, options: EventWaitOptions = {}): Promise<void> {
    return this.waitForEvents((events) => events.some(predicate), options)
  }

  private waitForEvents(predicate: (events: TEvent[]) => boolean, options: EventWaitOptions): Promise<void> {
    if (predicate(this.events)) return Promise.resolve()
    if (options.signal?.aborted) return Promise.resolve()

    return new Promise<void>((resolve) => {
      let waiter: (typeof this.waiters)[number]
      const cleanup = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const resolveOnce = () => {
        cleanup()
        resolve()
      }
      const onAbort = () => resolveOnce()
      waiter = { predicate, resolve: resolveOnce }
      this.waiters.push(waiter)
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
