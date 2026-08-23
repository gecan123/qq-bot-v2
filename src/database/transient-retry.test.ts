import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isTransientError, withTransientRetry } from './transient-retry.js'

describe('withTransientRetry', () => {
  test('retries bounded transient failures with exponential delays', async () => {
    let attempts = 0
    const delays: number[] = []
    const result = await withTransientRetry(async () => {
      attempts++
      if (attempts < 3) throw Object.assign(new Error('database unavailable'), { code: 'P1001' })
      return 'ok'
    }, { random: () => 0.5, sleep: async (ms) => { delays.push(ms) } })
    assert.equal(result, 'ok')
    assert.equal(attempts, 3)
    assert.deepEqual(delays, [50, 100])
  })

  test('does not retry deterministic failures', async () => {
    let attempts = 0
    await assert.rejects(withTransientRetry(async () => {
      attempts++
      throw Object.assign(new Error('unique constraint'), { code: 'P2002' })
    }, { sleep: async () => undefined }), /unique constraint/)
    assert.equal(attempts, 1)
  })

  test('recognizes nested transport causes', () => {
    assert.equal(isTransientError(new Error('outer', {
      cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    })), true)
  })

  test('adds bounded jitter to retry delays', async () => {
    const delays: number[] = []
    await assert.rejects(withTransientRetry(async () => {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    }, { maxAttempts: 2, random: () => 1, sleep: async ms => { delays.push(ms) } }))
    assert.equal(delays.length, 1)
    assert.ok(delays[0]! >= 57 && delays[0]! <= 58)
  })
})
