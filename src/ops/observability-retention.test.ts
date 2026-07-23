import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  purgeObservabilityData,
  type ObservabilityRetentionStore,
} from './observability-retention.js'

describe('purgeObservabilityData', () => {
  let tempDir: string

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'qq-bot-observability-retention-'))
  })

  after(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

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
      async deleteLlmCallsBefore(cutoff) {
        calls.push({ target: 'llm-calls', cutoff })
        return 56
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
      { target: 'llm-calls', cutoff },
    ])
    assert.equal(report.disabled, false)
    assert.equal(report.deletedToolCalls, 12)
    assert.equal(report.deletedTokenUsage, 34)
    assert.equal(report.deletedLlmCalls, 56)
    assert.deepEqual(report.failures, [])
  })

  test('zero retention disables database and file cleanup', async () => {
    let calls = 0
    const store: ObservabilityRetentionStore = {
      async deleteToolCallsBefore() { calls++; return 0 },
      async deleteTokenUsageBefore() { calls++; return 0 },
      async deleteLlmCallsBefore() { calls++; return 0 },
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
      async deleteLlmCallsBefore() { return 0 },
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

  test('atomically removes expired ts/time records and preserves retained lines byte-for-byte', async () => {
    const filePath = join(tempDir, 'mixed.ndjson')
    const retainedLines = [
      '{"ts":"2026-06-20T00:00:00.000+08:00","value":"cutoff-is-retained"}',
      '{ "time": "2026-07-19T23:00:00.000+08:00", "spaced": true }',
      'not json at all',
      '{"value":"missing timestamp"}',
      '{"ts":"not-a-date","value":"invalid timestamp"}',
    ]
    await writeFile(filePath, [
      '{"ts":"2026-06-19T23:59:59.999+08:00","value":"old-ts"}',
      retainedLines[0],
      '{"time":"2026-05-01T00:00:00.000+08:00","value":"old-time"}',
      ...retainedLines.slice(1),
    ].join('\n') + '\n', 'utf8')

    const report = await purgeObservabilityData({
      retentionDays: 30,
      now: () => new Date(2026, 6, 20),
      store: emptyStore(),
      ndjsonPaths: [filePath],
    })

    assert.equal(await readFile(filePath, 'utf8'), retainedLines.join('\n') + '\n')
    assert.deepEqual(report.files, [{
      path: filePath,
      removedLines: 2,
      retainedLines: 5,
      unparseableTimestampLines: 3,
    }])
    assert.deepEqual(report.failures, [])
  })

  test('treats missing files as a no-op and de-duplicates configured paths', async () => {
    const filePath = join(tempDir, 'deduplicated.ndjson')
    await writeFile(filePath, '{"ts":"2026-05-01T00:00:00.000+08:00"}\n', 'utf8')

    const report = await purgeObservabilityData({
      retentionDays: 30,
      now: () => new Date(2026, 6, 20),
      store: emptyStore(),
      ndjsonPaths: [filePath, join(tempDir, 'missing.ndjson'), filePath],
    })

    assert.equal(await readFile(filePath, 'utf8'), '')
    assert.equal(report.files.length, 1)
    assert.equal(report.files[0]?.removedLines, 1)
    assert.deepEqual(report.failures, [])
  })

  test('isolates file failures and continues other files after database cleanup', async () => {
    const badPath = join(tempDir, 'not-a-file')
    const goodPath = join(tempDir, 'good.ndjson')
    await mkdir(badPath)
    await writeFile(goodPath, '{"ts":"2026-05-01T00:00:00.000+08:00"}\n', 'utf8')
    let databaseCalls = 0
    const store: ObservabilityRetentionStore = {
      async deleteToolCallsBefore() { databaseCalls++; return 1 },
      async deleteTokenUsageBefore() { databaseCalls++; return 2 },
      async deleteLlmCallsBefore() { databaseCalls++; return 3 },
    }

    const report = await purgeObservabilityData({
      retentionDays: 30,
      now: () => new Date(2026, 6, 20),
      store,
      ndjsonPaths: [badPath, goodPath],
    })

    assert.equal(databaseCalls, 3)
    assert.equal(await readFile(goodPath, 'utf8'), '')
    assert.equal(report.files.length, 1)
    assert.equal(report.failures.length, 1)
    assert.equal(report.failures[0]?.target, badPath)
  })
})

function emptyStore(): ObservabilityRetentionStore {
  return {
    async deleteToolCallsBefore() { return 0 },
    async deleteTokenUsageBefore() { return 0 },
    async deleteLlmCallsBefore() { return 0 },
  }
}
