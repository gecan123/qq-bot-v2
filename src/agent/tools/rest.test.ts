import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import {
  createRestTool,
  DEFAULT_REST_DURATION_MINUTES,
  MAX_REST_DURATION_MINUTES,
  MIN_REST_DURATION_MINUTES,
  REST_COOLDOWN_MINUTES,
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
  test('requires an explicit reason and resume action with a simple bounded duration', () => {
    assert.equal(restTool.schema.safeParse({}).success, false)
    const parsed = restTool.schema.safeParse({
      reason: '连续专注后想主动放空一会儿',
      resumeAction: '醒来后继续写今天那篇关于 Agent 生活的短文',
    })
    assert.equal(parsed.success, true)
    assert.equal((parsed.data as { durationMinutes: number }).durationMinutes, 30)
    assert.equal(MIN_REST_DURATION_MINUTES, 10)
    assert.equal(DEFAULT_REST_DURATION_MINUTES, 30)
    assert.equal(MAX_REST_DURATION_MINUTES, 30)
    assert.equal(REST_COOLDOWN_MINUTES, 60)
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
      durationMinutes: 30,
      reason: '想休息',
      resumeAction: '醒来后重新评估是否还想继续阅读',
    }).success, true)
    assert.equal(restTool.schema.safeParse({
      durationMinutes: 31,
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

  test('uses a hard cooldown after a completed rest without disclosing a countdown', async () => {
    let nowMs = Date.parse('2026-08-27T04:00:00.000Z')
    const timer = makeFakeTimer((delayMs) => { nowMs += delayMs })
    const tool = createRestTool({ timer, now: () => nowMs })
    const { ctx } = makeContext()

    const first = tool.execute({
      durationMinutes: 30,
      reason: '主动休息一下',
      resumeAction: '醒来后重新评估是否有具体方向',
    }, ctx)
    timer.fire()
    assert.equal(JSON.parse((await first).content as string).status, 'elapsed')

    const blocked = await tool.execute({
      durationMinutes: 30,
      reason: '醒来后立刻继续休息',
      resumeAction: '稍后再重新评估',
    }, ctx)
    const blockedPayload = JSON.parse(blocked.content as string)
    assert.deepEqual(blockedPayload, {
      ok: false,
      code: 'rest_recently_used',
      error: '最近已经完成过一次休息，本轮不要再次围绕休息做决定；不要创建 Schedule 等待冷却。',
    })
    assert.equal(blocked.outcome?.continuation, 'backoff')
    assert.equal(JSON.stringify(blockedPayload).includes('remaining'), false)
    assert.equal(JSON.stringify(blockedPayload).includes('nextAllowedAt'), false)
    assert.deepEqual(timer.delays, [30 * 60_000])

    nowMs += REST_COOLDOWN_MINUTES * 60_000
    const allowed = tool.execute({
      durationMinutes: 10,
      reason: '冷却后再次主动休息',
      resumeAction: '醒来后继续当前方向',
    }, ctx)
    timer.fire()
    assert.equal(JSON.parse((await allowed).content as string).status, 'elapsed')
    assert.deepEqual(timer.delays, [30 * 60_000, 10 * 60_000])
  })

  test('attention interrupts rest without starting the completed-rest cooldown', async () => {
    let nowMs = Date.parse('2026-08-27T04:00:00.000Z')
    const timer = makeFakeTimer((delayMs) => { nowMs += delayMs })
    const tool = createRestTool({ timer, now: () => nowMs })
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

    queue.clear()
    const resumedRest = tool.execute({
      durationMinutes: 30,
      reason: '处理完注意事件后仍想继续休息',
      resumeAction: '醒来后重新评估是否有具体方向',
    }, ctx)
    assert.deepEqual(timer.delays, [30 * 60_000, 30 * 60_000])
    timer.fire()
    const resumedPayload = JSON.parse((await resumedRest).content as string)
    assert.equal(resumedPayload.status, 'elapsed')
    assert.equal(resumedPayload.durationMinutes, 30)
  })
})
