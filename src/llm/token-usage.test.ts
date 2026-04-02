import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  getCurrentTokenUsageTracker,
  recordCurrentTokenUsage,
  runWithTokenUsageTracking,
} from './token-usage.js'

describe('token usage tracking', () => {
  test('aggregates usage across nested async calls', async () => {
    const summary = await runWithTokenUsageTracking(async () => {
      recordCurrentTokenUsage('generateReply', {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
      })

      await Promise.resolve()

      recordCurrentTokenUsage('agent.chat', {
        promptTokens: 200,
        completionTokens: 50,
        totalTokens: 250,
      })

      return getCurrentTokenUsageTracker()?.snapshot()
    })

    assert.ok(summary)
    assert.equal(summary.total.promptTokens, 320)
    assert.equal(summary.total.completionTokens, 80)
    assert.equal(summary.total.totalTokens, 400)
    assert.equal(summary.total.calls, 2)
    assert.deepEqual(summary.byOperation.generateReply, {
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      calls: 1,
    })
    assert.deepEqual(summary.byOperation['agent.chat'], {
      promptTokens: 200,
      completionTokens: 50,
      totalTokens: 250,
      calls: 1,
    })
  })

  test('returns callback result from tracked scope', async () => {
    const result = await runWithTokenUsageTracking(async () => {
      recordCurrentTokenUsage('generateReply', {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      })
      return 'ok'
    })

    assert.equal(result, 'ok')
  })
})
