import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createRestTool, restTool } from './rest.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

function makeCtx(): { ctx: ToolContext; queue: InMemoryEventQueue<BotEvent> } {
  const queue = new InMemoryEventQueue<BotEvent>()
  return { ctx: { eventQueue: queue, roundIndex: 0 }, queue }
}

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

function groupEvent(overrides: Partial<Extract<BotEvent, { type: 'napcat_message' }>> = {}): BotEvent {
  return {
    type: 'napcat_message',
    messageRowId: 1,
    groupId: 100,
    messageId: 200,
    senderId: 300,
    senderNickname: '群友',
    mentionedSelf: false,
    sentAt: new Date('2026-06-17T08:00:00.000Z'),
    renderedText: 'hello',
    ...overrides,
  }
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

describe('rest tool', () => {
  test('schema requires an intention and defaults to 60 seconds', () => {
    assert.equal(restTool.schema.safeParse({}).success, false)
    const parsed = restTool.schema.safeParse({
      reason: '刚完成一段活动，想短暂放空',
      intention: TEST_INTENTION,
    })
    assert.equal(parsed.success, true)
    const data = parsed.data as { durationSeconds: number }
    assert.equal(data.durationSeconds, 60)
  })

  test('description frames intention as two concrete directions', () => {
    const tool = createRestTool()
    assert.match(tool.description, /primaryDirection.*alternativeDirection/)
    assert.match(tool.description, /不要为了填菜单制造六个占位方向/)
    assert.match(tool.description, /机械检查行情/)
    assert.match(tool.description, /未来某个时点再看时用 schedule/)
    assert.match(tool.description, /没有未处理义务或牵引力就结束当前活动轮/)
    assert.match(tool.description, /立即进入计时/)
  })

  test('already queued mentioned group message interrupts rest without consuming the event', async () => {
    const { ctx, queue } = makeCtx()
    queue.enqueue(groupEvent({ mentionedSelf: true }))

    const result = await restTool.execute({
      durationSeconds: 30,
      reason: '短暂放空',
      intention: TEST_INTENTION,
    }, ctx)

    const payload = JSON.parse(result.content as string)
    assert.equal(payload.ok, true)
    assert.equal(payload.status, 'interrupted')
    assert.equal(payload.durationSeconds, 30)
    assert.equal(typeof payload.elapsedMs, 'number')
    assert.equal(payload.restReason, '短暂放空')
    assert.equal(payload.resumePlan.primaryDirection, TEST_INTENTION.primaryDirection)
    assert.deepEqual(result.outcome, { ok: true, code: 'interrupted' })
    assert.deepEqual(result.effects, [{ type: 'pause', status: 'interrupted' }])
    assert.equal(queue.size(), 1)
  })

  test('already queued private message interrupts rest without consuming the event', async () => {
    const { ctx, queue } = makeCtx()
    queue.enqueue(privateEvent())

    const result = await restTool.execute({
      durationSeconds: 30,
      reason: '短暂放空',
      intention: TEST_INTENTION,
    }, ctx)

    assert.equal(JSON.parse(result.content as string).status, 'interrupted')
    assert.deepEqual(result.effects, [{ type: 'pause', status: 'interrupted' }])
    assert.equal(queue.size(), 1)
  })

  test('plain group message does not interrupt rest', async () => {
    const timer = makeFakeTimer()
    const tool = createRestTool({ timer })
    const { ctx, queue } = makeCtx()
    queue.enqueue(groupEvent({ mentionedSelf: false }))

    const restPromise = tool.execute({
      durationSeconds: 30,
      reason: '短暂放空',
      intention: TEST_INTENTION,
    }, ctx)
    const result = await Promise.race([
      restPromise.then(() => 'returned' as const),
      tickMicrotasks().then(() => 'pending' as const),
    ])

    assert.equal(result, 'pending')
    assert.equal(queue.size(), 1)

    timer.fire()
    const finalResult = await restPromise
    const payload = JSON.parse(finalResult.content as string)
    assert.equal(payload.ok, true)
    assert.equal(payload.status, 'elapsed')
    assert.equal(payload.durationSeconds, 30)
    assert.equal(payload.resumePlan.primaryDirection, TEST_INTENTION.primaryDirection)
    assert.equal(typeof payload.elapsedMs, 'number')
    assert.deepEqual(finalResult.outcome, { ok: true, code: 'elapsed' })
    assert.deepEqual(finalResult.effects, [{ type: 'pause', status: 'elapsed' }])
  })
})

const TEST_INTENTION = {
  primaryDirection: '复核一条 SOL 观察假设的失效条件',
  alternativeDirection: '挑一篇群友文章读第一节',
}

function tickMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
