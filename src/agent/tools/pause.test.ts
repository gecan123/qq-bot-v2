import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createPauseTool, pauseTool } from './pause.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

interface FakeTimer {
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  fire(): void
}

function makeFakeTimer(): FakeTimer {
  let nextId = 1
  const handlers = new Map<number, () => void>()
  return {
    setTimeout(cb) {
      const id = nextId++
      handlers.set(id, cb)
      return id
    },
    clearTimeout(handle) {
      handlers.delete(handle as number)
    },
    fire() {
      const entries = [...handlers.entries()]
      for (const [id, cb] of entries) {
        handlers.delete(id)
        cb()
      }
    },
  }
}

function makeCtx(): { ctx: ToolContext; queue: InMemoryEventQueue<BotEvent> } {
  const queue = new InMemoryEventQueue<BotEvent>()
  return { ctx: { eventQueue: queue, roundIndex: 0 }, queue }
}

function privateEvent(): BotEvent {
  return {
    type: 'napcat_private_message',
    messageRowId: 2,
    peerId: 400,
    messageId: 500,
    senderId: 400,
    senderNickname: '朋友',
    mentionedSelf: true,
    sentAt: new Date('2026-06-17T08:00:01.000Z'),
    renderedText: '醒醒',
  }
}

describe('pause tool', () => {
  test('schema accepts wait and rest actions', () => {
    assert.equal(pauseTool.schema.safeParse({ action: 'wait' }).success, true)

    const rest = pauseTool.schema.safeParse({ action: 'rest' })
    assert.equal(rest.success, true)
    assert.equal((rest.data as { durationSeconds: number }).durationSeconds, 30)
  })

  test('action=wait delegates to wait behavior', async () => {
    const timer = makeFakeTimer()
    const tool = createPauseTool({ wait: { idleHintMs: 600_000, timer } })
    const { ctx } = makeCtx()

    const promise = tool.execute({ action: 'wait' }, ctx)
    timer.fire()
    const result = await promise

    assert.match(result.content as string, /\[空闲提示\]/)
    assert.match(result.content as string, /10 分钟/)
  })

  test('action=rest delegates to rest behavior', async () => {
    const { ctx, queue } = makeCtx()
    queue.enqueue(privateEvent())

    const result = await pauseTool.execute({ action: 'rest', durationSeconds: 30 }, ctx)

    assert.match(result.content as string, /\[休息被打断\]/)
    assert.equal(queue.size(), 1)
  })
})
