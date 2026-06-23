import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createWaitTool } from './wait.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

interface FakeTimer {
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  fire(): void
  pending(): number
  cleared(): number
}

function makeFakeTimer(): FakeTimer {
  let nextId = 1
  const handlers = new Map<number, () => void>()
  const cleared = new Set<number>()
  return {
    setTimeout(cb) {
      const id = nextId++
      handlers.set(id, cb)
      return id
    },
    clearTimeout(handle) {
      const id = handle as number
      if (handlers.has(id)) {
        cleared.add(id)
        handlers.delete(id)
      }
    },
    fire() {
      const entries = [...handlers.entries()]
      for (const [id, cb] of entries) {
        handlers.delete(id)
        cb()
      }
    },
    pending() {
      return handlers.size
    },
    cleared() {
      return cleared.size
    },
  }
}

function makeCtx(): { ctx: ToolContext; queue: InMemoryEventQueue<BotEvent> } {
  const queue = new InMemoryEventQueue<BotEvent>()
  return { ctx: { eventQueue: queue, roundIndex: 0 }, queue }
}

describe('wait tool — idle race', () => {
  test('real event arrives first → returns ok, no idle hint, timer cleared (no leak)', async () => {
    const timer = makeFakeTimer()
    const tool = createWaitTool({ idleHintMs: 1_000_000, timer })
    const { ctx, queue } = makeCtx()

    const promise = tool.execute({}, ctx)
    await tickMicrotasks()
    assert.equal(timer.pending(), 1, 'idle timer should be armed')

    queue.enqueue({ type: 'napcat_message' } as BotEvent)
    const result = await promise

    assert.match((result.content as string), /\[当前北京时间: .+\] ok$/)
    assert.equal(timer.pending(), 0, 'timer must be cleared on event win')
    assert.equal(timer.cleared(), 1)
  })

  test('idle timeout fires first → returns idle hint, does NOT enqueue wake', async () => {
    const timer = makeFakeTimer()
    const tool = createWaitTool({ idleHintMs: 1_800_000, timer })
    const { ctx, queue } = makeCtx()

    const promise = tool.execute({}, ctx)
    await tickMicrotasks()
    assert.equal(queue.size(), 0)

    timer.fire()
    const result = await promise

    assert.match((result.content as string), /\[空闲提示\]/)
    assert.match((result.content as string), /30 分钟/)
    assert.match((result.content as string), /创作者/)
    assert.match((result.content as string), /工具/)
    assert.match((result.content as string), /事件/)
    assert.match((result.content as string), /fetch reddit list/)
    assert.match((result.content as string), /journal write/)
    assert.match((result.content as string), /pause action=wait/)
    // 关键: wait 是一次非 send_message toolCall, 主循环会自动跑下一轮, 不用 wake 戳.
    assert.equal(queue.size(), 0, 'no wake enqueue needed')
  })

  test('idle hint includes minute value derived from idleHintMs', async () => {
    const timer = makeFakeTimer()
    const tool = createWaitTool({ idleHintMs: 600_000, timer })
    const { ctx } = makeCtx()
    const promise = tool.execute({}, ctx)
    timer.fire()
    const result = await promise
    assert.match((result.content as string), /10 分钟/)
  })

  test('idle hint description mentions the configured threshold', () => {
    const timer = makeFakeTimer()
    const tool = createWaitTool({ idleHintMs: 1_800_000, timer })
    assert.match(tool.description, /30 分钟/)
  })

  test('wait does not throw if event arrives before microtask scheduling completes', async () => {
    const timer = makeFakeTimer()
    const tool = createWaitTool({ idleHintMs: 1_000_000, timer })
    const { ctx, queue } = makeCtx()
    queue.enqueue({ type: 'wake' } as BotEvent)
    const result = await tool.execute({}, ctx)
    assert.match((result.content as string), /\[当前北京时间: .+\] ok$/)
  })
})

function tickMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
