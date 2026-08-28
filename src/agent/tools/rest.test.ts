import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import {
  createRestBudget,
  createRestTool,
  DAY_REST_LIMIT_MINUTES,
  DEFAULT_REST_DURATION_MINUTES,
  MAX_REST_DURATION_MINUTES,
  MIN_REST_DURATION_MINUTES,
  NIGHT_REST_LIMIT_MINUTES,
  REST_WINDOW_MINUTES,
  restTool,
} from './rest.js'

function makeContext(): { ctx: ToolContext; queue: InMemoryEventQueue<BotEvent> } {
  const queue = new InMemoryEventQueue<BotEvent>()
  return { ctx: { eventQueue: queue, roundIndex: 1 }, queue }
}

function makeFakeTimer(onFire?: (delayMs: number) => void): {
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
        onFire?.(delays[id - 1]!)
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
    assert.equal((parsed.data as { durationMinutes: number }).durationMinutes, 30)
    assert.equal(MIN_REST_DURATION_MINUTES, 10)
    assert.equal(DEFAULT_REST_DURATION_MINUTES, 30)
    assert.equal(MAX_REST_DURATION_MINUTES, 120)
    assert.equal(REST_WINDOW_MINUTES, 180)
    assert.equal(DAY_REST_LIMIT_MINUTES, 60)
    assert.equal(NIGHT_REST_LIMIT_MINUTES, 120)
    assert.equal(restTool.schema.safeParse({
      durationMinutes: 10,
      reason: '想休息',
      resumeAction: '醒来后重新评估是否还想继续阅读',
    }).success, true)
    assert.equal(restTool.schema.safeParse({
      durationMinutes: 9,
      reason: '想休息',
      resumeAction: '醒来后重新评估是否还想继续阅读',
    }).success, false)
    assert.equal(restTool.schema.safeParse({
      durationMinutes: 120,
      reason: '想休息',
      resumeAction: '醒来后重新评估是否还想继续阅读',
    }).success, true)
    assert.equal(restTool.schema.safeParse({
      durationMinutes: 121,
      reason: '想休息',
      resumeAction: '醒来后重新评估是否还想继续阅读',
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
      requestedDurationMinutes: 12,
      durationMinutes: 12,
      reason: '主动休息一下',
      resumeAction: '醒来后完成一段具体写作',
    })
    assert.deepEqual(result.outcome, {
      ok: true,
      code: 'rest_elapsed',
      progress: false,
      continuation: 'immediate',
      continuationDetail: '主动休息结束，重新评估是否有值得推进的具体方向',
    })
  })

  test('attention interrupts rest, records actual elapsed time, and does not consume the event', async () => {
    let nowMs = Date.parse('2026-08-27T04:00:00.000Z')
    const budget = createRestBudget()
    const timer = makeFakeTimer((delayMs) => { nowMs += delayMs })
    const tool = createRestTool({ timer, now: () => nowMs, budget })
    const { ctx, queue } = makeContext()
    const promise = tool.execute({
      durationMinutes: 30,
      reason: '主动休息一下',
      resumeAction: '醒来后继续整理文章结构',
    }, ctx)
    nowMs += 5 * 60_000
    queue.enqueue({ type: 'wake' })

    const result = await promise
    assert.equal(JSON.parse(result.content as string).status, 'interrupted')
    assert.equal(result.outcome?.code, 'rest_interrupted')
    assert.equal(result.outcome?.continuation, 'immediate')
    assert.equal(queue.size(), 1)

    const resumedRest = tool.execute({
      durationMinutes: 60,
      reason: '处理完注意事件后仍想继续休息',
      resumeAction: '醒来后重新评估是否有具体方向',
    }, ctx)
    assert.deepEqual(timer.delays, [30 * 60_000, 55 * 60_000])
    timer.fire()
    const resumedPayload = JSON.parse((await resumedRest).content as string)
    assert.equal(resumedPayload.status, 'elapsed')
    assert.equal(resumedPayload.requestedDurationMinutes, 60)
    assert.equal(resumedPayload.durationMinutes, 55)
  })

  test('shortens rest to the current rolling-window budget and backs off when exhausted', async () => {
    let nowMs = Date.parse('2026-08-27T04:00:00.000Z')
    const timer = makeFakeTimer((delayMs) => { nowMs += delayMs })
    const tool = createRestTool({ timer, now: () => nowMs })
    const { ctx } = makeContext()

    const first = tool.execute({
      durationMinutes: 120,
      reason: '主动休息一下',
      resumeAction: '醒来后重新评估是否有具体方向',
    }, ctx)
    assert.deepEqual(timer.delays, [60 * 60_000])
    timer.fire()
    const firstPayload = JSON.parse((await first).content as string)
    assert.equal(firstPayload.status, 'elapsed')
    assert.equal(firstPayload.durationMinutes, 60)

    const second = await tool.execute({
      durationMinutes: 30,
      reason: '醒来后仍然没有牵引力，继续放假',
      resumeAction: '稍后再重新评估',
    }, ctx)
    assert.equal(JSON.parse(second.content as string).code, 'rest_budget_exhausted')
    assert.equal(second.outcome?.continuation, 'backoff')
    assert.deepEqual(timer.delays, [60 * 60_000])
  })
})

describe('rest rolling budget', () => {
  test('allows one third of a rolling three-hour daytime window', () => {
    const budget = createRestBudget()
    const noon = Date.parse('2026-08-27T04:00:00.000Z') // 12:00 Asia/Singapore

    assert.deepEqual(budget.authorize(120, noon), {
      period: 'day',
      requestedDurationMinutes: 120,
      grantedDurationMinutes: 60,
    })
    budget.record(noon, noon + 40 * 60_000)
    assert.equal(budget.authorize(30, noon + 40 * 60_000).grantedDurationMinutes, 20)
  })

  test('allows two thirds of a rolling three-hour night window', () => {
    const budget = createRestBudget()
    const midnight = Date.parse('2026-08-26T16:00:00.000Z') // 00:00 Asia/Singapore

    assert.deepEqual(budget.authorize(120, midnight), {
      period: 'night',
      requestedDurationMinutes: 120,
      grantedDurationMinutes: 120,
    })
    budget.record(midnight, midnight + 120 * 60_000)
    assert.equal(budget.authorize(10, midnight + 120 * 60_000).grantedDurationMinutes, 0)
    assert.equal(budget.authorize(10, midnight + 190 * 60_000).grantedDurationMinutes, 10)
  })

  test('never grants a rest across the next day/night boundary', () => {
    const budget = createRestBudget()
    const beforeMidnight = Date.parse('2026-08-26T15:30:00.000Z') // 23:30 Asia/Singapore
    const beforeMorning = Date.parse('2026-08-26T21:30:00.000Z') // 05:30 Asia/Singapore

    assert.equal(budget.authorize(60, beforeMidnight).grantedDurationMinutes, 30)
    assert.equal(budget.authorize(60, beforeMorning).grantedDurationMinutes, 30)
  })

  test('keeps recent night rest in the window when the daytime limit takes effect', () => {
    const budget = createRestBudget()
    const threeAtNight = Date.parse('2026-08-26T19:00:00.000Z') // 03:00 Asia/Singapore
    const sixInMorning = Date.parse('2026-08-26T22:00:00.000Z') // 06:00 Asia/Singapore

    budget.record(threeAtNight, threeAtNight + 120 * 60_000)
    assert.equal(budget.authorize(30, sixInMorning).grantedDurationMinutes, 0)
  })
})
