import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import {
  createRestTool,
  DEFAULT_REST_DURATION_MINUTES,
  MAX_REST_DURATION_MINUTES,
  REST_COOLDOWN_MINUTES,
  restTool,
} from './rest.js'

function makeContext(): { ctx: ToolContext; queue: InMemoryEventQueue<BotEvent> } {
  const queue = new InMemoryEventQueue<BotEvent>()
  return { ctx: { eventQueue: queue, roundIndex: 1 }, queue }
}

function makeFakeTimer(): {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  fire: () => void
  delays: number[]
} {
  const callbacks = new Map<number, () => void>()
  const delays: number[] = []
  let nextId = 1
  return {
    delays,
    setTimeout(callback, ms) {
      const id = nextId++
      callbacks.set(id, callback)
      delays.push(ms)
      return id
    },
    clearTimeout(handle) {
      callbacks.delete(handle as number)
    },
    fire() {
      for (const [id, callback] of [...callbacks]) {
        callbacks.delete(id)
        callback()
      }
    },
  }
}

describe('rest tool', () => {
  test('requires an explicit reason and resume action with a bounded duration', () => {
    assert.equal(restTool.schema.safeParse({}).success, false)
    const parsed = restTool.schema.safeParse({
      reason: '连续专注后想主动放空一会儿',
      resumeAction: '醒来后继续写今天那篇关于 Agent 生活的短文',
    })
    assert.equal(parsed.success, true)
    assert.equal((parsed.data as { durationMinutes: number }).durationMinutes, 10)
    assert.equal(DEFAULT_REST_DURATION_MINUTES, 10)
    assert.equal(MAX_REST_DURATION_MINUTES, 60)
    assert.equal(restTool.schema.safeParse({
      durationMinutes: 61,
      reason: '想休息',
      resumeAction: '醒来后继续阅读',
    }).success, false)
  })

  test('waits for the requested duration and then immediately returns control', async () => {
    const timer = makeFakeTimer()
    const tool = createRestTool({ timer })
    const { ctx } = makeContext()
    const promise = tool.execute({
      durationMinutes: 12,
      reason: '主动休息一下',
      resumeAction: '醒来后完成一段具体写作',
    }, ctx)

    assert.deepEqual(timer.delays, [12 * 60_000])
    timer.fire()
    const result = await promise

    assert.deepEqual(JSON.parse(result.content as string), {
      ok: true,
      status: 'elapsed',
      durationMinutes: 12,
      reason: '主动休息一下',
      resumeAction: '醒来后完成一段具体写作',
    })
    assert.deepEqual(result.outcome, {
      ok: true,
      code: 'rest_elapsed',
      progress: false,
      continuation: 'immediate',
      continuationDetail: '主动休息结束，立即执行醒后方向',
    })
  })

  test('attention interrupts rest without consuming the event', async () => {
    const timer = makeFakeTimer()
    const tool = createRestTool({ timer })
    const { ctx, queue } = makeContext()
    const promise = tool.execute({
      durationMinutes: 30,
      reason: '主动休息一下',
      resumeAction: '醒来后继续整理文章结构',
    }, ctx)
    queue.enqueue({ type: 'wake' })

    const result = await promise
    assert.equal(JSON.parse(result.content as string).status, 'interrupted')
    assert.equal(result.outcome?.code, 'rest_interrupted')
    assert.equal(result.outcome?.continuation, 'immediate')
    assert.equal(queue.size(), 1)

    const blocked = await tool.execute({
      durationMinutes: 10,
      reason: '想再休息一下',
      resumeAction: '醒来后继续整理文章结构',
    }, ctx)
    assert.equal(JSON.parse(blocked.content as string).code, 'rest_cooldown')
    assert.equal(blocked.outcome?.code, 'rest_cooldown')
  })

  test('rejects another rest for sixty minutes after the previous rest ends', async () => {
    const timer = makeFakeTimer()
    let nowMs = 0
    const tool = createRestTool({ timer, now: () => nowMs })
    const { ctx } = makeContext()
    const args = {
      durationMinutes: 10,
      reason: '主动休息一下',
      resumeAction: '醒来后继续写作',
    }

    const first = tool.execute(args, ctx)
    timer.fire()
    assert.equal(JSON.parse((await first).content as string).status, 'elapsed')

    const blocked = await tool.execute(args, ctx)
    assert.deepEqual(JSON.parse(blocked.content as string), {
      ok: false,
      code: 'rest_cooldown',
      retryAfterMinutes: REST_COOLDOWN_MINUTES,
      error: '休息冷却中，还需至少 60 分钟；现在选择一个非 rest 的具体行动。',
    })
    assert.equal(blocked.outcome?.ok, false)
    assert.equal(blocked.outcome?.code, 'rest_cooldown')
    assert.equal(timer.delays.length, 1)

    nowMs += REST_COOLDOWN_MINUTES * 60_000
    const allowed = tool.execute(args, ctx)
    assert.equal(timer.delays.length, 2)
    timer.fire()
    assert.equal(JSON.parse((await allowed).content as string).status, 'elapsed')
  })
})
