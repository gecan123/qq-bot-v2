import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  purgeObservabilityData,
  type ObservabilityRetentionStore,
} from './observability-retention.js'

describe('purgeObservabilityData', () => {
  test('deletes both observability tables before the configured local-midnight cutoff', async () => {
    const calls: Array<{ target: string; cutoff: Date }> = []
    const store: ObservabilityRetentionStore = {
      async deleteToolCallsBefore(cutoff) {
        calls.push({ target: 'tool-calls', cutoff })
        return 12
      },
      async deleteTokenUsageBefore(cutoff) {
        calls.push({ target: 'token-usage', cutoff })
        return 34
      },
    }

    const report = await purgeObservabilityData({
      retentionDays: 30,
      now: () => new Date(2026, 6, 20, 18, 30),
      store,
      ndjsonPaths: [],
    })

    const cutoff = new Date(2026, 5, 20)
    assert.deepEqual(calls, [
      { target: 'tool-calls', cutoff },
      { target: 'token-usage', cutoff },
    ])
    assert.equal(report.disabled, false)
    assert.equal(report.deletedToolCalls, 12)
    assert.equal(report.deletedTokenUsage, 34)
    assert.deepEqual(report.failures, [])
  })

  test('zero retention disables database and file cleanup', async () => {
    let calls = 0
    const store: ObservabilityRetentionStore = {
      async deleteToolCallsBefore() { calls++; return 0 },
      async deleteTokenUsageBefore() { calls++; return 0 },
    }

    const report = await purgeObservabilityData({
      retentionDays: 0,
      store,
      ndjsonPaths: ['/path/that/must/not/be/read.ndjson'],
    })

    assert.equal(calls, 0)
    assert.equal(report.disabled, true)
  })

  test('isolates database target failures and continues remaining cleanup', async () => {
    let tokenCleanupRan = false
    const store: ObservabilityRetentionStore = {
      async deleteToolCallsBefore() { throw new Error('tool cleanup failed') },
      async deleteTokenUsageBefore() { tokenCleanupRan = true; return 5 },
    }

    const report = await purgeObservabilityData({
      retentionDays: 30,
      now: () => new Date(2026, 6, 20),
      store,
      ndjsonPaths: [],
    })

    assert.equal(tokenCleanupRan, true)
    assert.equal(report.deletedTokenUsage, 5)
    assert.deepEqual(report.failures, [{ target: 'agent_tool_calls', error: 'tool cleanup failed' }])
  })
})
