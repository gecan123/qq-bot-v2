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

    assert.equal(result.content, 'ok')
    assert.equal(timer.pending(), 0, 'timer must be cleared on event win')
    assert.equal(timer.cleared(), 1)
  })

  test('idle timeout fires first → returns idle hint, does NOT enqueue wake (Guard 2 keys on hadToolCalls)', async () => {
    const timer = makeFakeTimer()
    const tool = createWaitTool({ idleHintMs: 1_800_000, timer })
    const { ctx, queue } = makeCtx()

    const promise = tool.execute({}, ctx)
    await tickMicrotasks()
    assert.equal(queue.size(), 0)

    timer.fire()
    const result = await promise

    assert.match(result.content, /\[空闲提示\]/)
    assert.match(result.content, /30 分钟/)
    // 关键: wait 是一次 toolCall, 主循环看 hadToolCalls=true 自动跑下一轮, 不用 wake 戳.
    assert.equal(queue.size(), 0, 'no wake enqueue — Guard 2 reads hadToolCalls now')
  })

  test('idle hint includes minute value derived from idleHintMs', async () => {
    const timer = makeFakeTimer()
    const tool = createWaitTool({ idleHintMs: 600_000, timer })
    const { ctx } = makeCtx()
    const promise = tool.execute({}, ctx)
    timer.fire()
    const result = await promise
    assert.match(result.content, /10 分钟/)
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
    assert.equal(result.content, 'ok')
  })
})

function tickMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
