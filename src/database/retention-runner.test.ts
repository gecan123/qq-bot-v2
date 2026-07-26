import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createDailyRetentionRunner,
  millisecondsUntilNextBeijingHour,
} from './retention-runner.js'

describe('daily retention runner', () => {
  test('calculates the next 03:00 in Beijing without relying on process timezone', () => {
    assert.equal(
      millisecondsUntilNextBeijingHour(new Date('2026-07-26T18:30:00.000Z'), 3),
      30 * 60 * 1_000,
    )
    assert.equal(
      millisecondsUntilNextBeijingHour(new Date('2026-07-26T19:30:00.000Z'), 3),
      23.5 * 60 * 60 * 1_000,
    )
  })

  test('runs once on start, arms the next Beijing run, and cancels on stop', async () => {
    let runs = 0
    let armedDelay: number | null = null
    let cleared = false
    const fakeTimer = { unref() {} } as ReturnType<typeof setTimeout>
    const runner = createDailyRetentionRunner({
      async run() { runs++ },
      now: () => new Date('2026-07-26T18:30:00.000Z'),
      setTimer(_callback, delayMs) {
        armedDelay = delayMs
        return fakeTimer
      },
      clearTimer(timer) {
        assert.equal(timer, fakeTimer)
        cleared = true
      },
    })

    runner.start()
    await Promise.resolve()
    assert.equal(runs, 1)
    assert.equal(armedDelay, 30 * 60 * 1_000)

    await runner.stop()
    assert.equal(cleared, true)
  })

  test('coalesces a timer firing with an active startup cleanup', async () => {
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    let runs = 0
    const callbacks: Array<() => void> = []
    const runner = createDailyRetentionRunner({
      async run() {
        runs++
        await blocker
      },
      setTimer(next) {
        callbacks.push(next)
        return { unref() {} } as ReturnType<typeof setTimeout>
      },
      clearTimer() {},
    })

    runner.start()
    await Promise.resolve()
    callbacks[0]!()
    assert.equal(runs, 1)
    release()
    await blocker
    await runner.stop()
  })

  test('routes synchronous cleanup failures through the error handler', async () => {
    const errors: unknown[] = []
    const runner = createDailyRetentionRunner({
      run() {
        throw new Error('sync cleanup failure')
      },
      setTimer() {
        return { unref() {} } as ReturnType<typeof setTimeout>
      },
      clearTimer() {},
      onError(error) {
        errors.push(error)
      },
    })

    assert.doesNotThrow(() => runner.start())
    await runner.stop()
    assert.equal(errors.length, 1)
    assert.match(String(errors[0]), /sync cleanup failure/)
  })
})
