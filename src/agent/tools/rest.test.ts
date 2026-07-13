import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createRestTool, hasPendingRestAlternative, restTool } from './rest.js'
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
  test('durably recognizes only the latest completed alternative result', () => {
    const alternativeResult = JSON.stringify({
      ok: true,
      status: 'alternative_available',
      paused: false,
    })
    const messages = [
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'pause-1', name: 'pause', args: {} }],
      },
      { role: 'tool' as const, toolCallId: 'pause-1', content: alternativeResult },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'pause-2', name: 'pause', args: { confirmed: true } }],
      },
    ]

    assert.equal(hasPendingRestAlternative(messages), true)
    assert.equal(hasPendingRestAlternative([
      ...messages,
      { role: 'tool' as const, toolCallId: 'other-1', content: '{"ok":true}' },
    ]), false)
  })

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
    assert.match(tool.description, /不是“今天全部完成”/)
  })

  test('first request returns a journal alternative without pausing', async () => {
    let picked = 0
    const tool = createRestTool({
      pickAlternative: async () => {
        picked++
        return {
          thought: '我还惦记着 QuadRF 那条没查完的供应链线索，先把第一个器件来源钉住。',
          direction: '继续拆解 QuadRF 众筹页面的供应链线索',
          anchorSource: 'agenda',
          whyNow: 'Agenda 里仍是 Active',
          firstStep: '打开现有 notebook 并列出第一条待查证问题',
          promoteToGoal: true,
        }
      },
    })
    const { ctx, queue } = makeCtx()

    const result = await tool.execute({
      durationSeconds: 30,
      confirmed: false,
      reason: '刚完成一件事，想停一下',
      intention: TEST_INTENTION,
    }, ctx)

    assert.equal(picked, 1)
    assert.deepEqual(result.outcome, { ok: true, code: 'alternative_available' })
    assert.equal(result.effects, undefined)
    assert.deepEqual(JSON.parse(result.content as string), {
      ok: true,
      status: 'alternative_available',
      paused: false,
      idleThought: {
        event: 'idle_thought',
        thought: '我还惦记着 QuadRF 那条没查完的供应链线索，先把第一个器件来源钉住。',
        direction: '继续拆解 QuadRF 众筹页面的供应链线索',
        anchorSource: 'agenda',
        whyNow: 'Agenda 里仍是 Active',
        firstStep: '打开现有 notebook 并列出第一条待查证问题',
        promoteToGoal: true,
      },
      instruction: '没有进入休息。idleThought 是你自己的念头而不是任务；若它确实有吸引力且值得跨多轮推进, 用 goal action=create_self 建立持久主线并完成 firstStep。若让它过去后仍真想休息, 再次调用 pause 并设 confirmed=true.',
    })

    queue.enqueue(privateEvent())
    const confirmed = await tool.execute({
      durationSeconds: 30,
      confirmed: true,
      reason: '看过建议后仍然确实想短暂放空',
      intention: TEST_INTENTION,
    }, { ...ctx, roundIndex: ctx.roundIndex + 1 })
    assert.equal(picked, 1)
    assert.equal(JSON.parse(confirmed.content as string).status, 'interrupted')
    assert.deepEqual(confirmed.effects, [{ type: 'pause', status: 'interrupted' }])
  })

  test('confirmed cannot bypass the first alternative check', async () => {
    let picked = 0
    const tool = createRestTool({
      pickAlternative: async () => {
        picked++
        return null
      },
    })
    const { ctx } = makeCtx()

    const result = await tool.execute({
      durationSeconds: 30,
      confirmed: true,
      reason: '想直接跳过检查',
      intention: TEST_INTENTION,
    }, ctx)

    assert.equal(picked, 0)
    assert.deepEqual(result.outcome, { ok: true, code: 'confirmation_required' })
    assert.equal(result.effects, undefined)
    assert.deepEqual(JSON.parse(result.content as string), {
      ok: true,
      status: 'confirmation_required',
      paused: false,
      instruction: '没有进入休息。confirmed 不能用于跳过第一次检查; 请先以 confirmed=false 调用并查看是否返回 alternative_available.',
    })
  })

  test('already queued mentioned group message interrupts rest without consuming the event', async () => {
    const { ctx, queue } = makeCtx()
    queue.enqueue(groupEvent({ mentionedSelf: true }))

    const result = await restTool.execute({
      durationSeconds: 30,
      confirmed: false,
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
      confirmed: false,
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
      confirmed: false,
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
