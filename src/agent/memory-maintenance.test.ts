import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmClient } from './llm-client.js'
import { createMemoryMaintenanceRuntime } from './memory-maintenance.js'
import { inspectMemoryFileForMaintenance, writeMemoryEntry } from './memory-store.js'
import { createTaskScheduler } from './task-scheduler.js'

describe('memory maintenance runtime', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'memory-maintenance-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  test('does not call the reviewer below all maintenance thresholds', async () => {
    let calls = 0
    const llm: LlmClient = {
      async chat() {
        calls++
        throw new Error('reviewer should not run')
      },
    }
    await writeMemoryEntry({ rootDir }, {
      scope: 'self', title: 'methods', content: '先看真实日志',
    })
    const runtime = createMemoryMaintenanceRuntime({
      rootDir,
      llm,
      recentEntryThreshold: 3,
      recentCharThreshold: 1_000,
      recordUsage() {},
    })

    runtime.enqueue('self/methods.md')
    await runtime.drain()

    assert.equal(calls, 0)
  })

  test('merges fragmented recent entries through one bounded atomic review', async () => {
    let calls = 0
    let nextId = 0
    const options = { rootDir, id: () => `entry-${++nextId}` }
    await writeMemoryEntry(options, { scope: 'self', title: 'methods', content: '排障时先看代码' })
    await writeMemoryEntry(options, { scope: 'self', title: 'methods', content: '排障时也看实际日志' })
    await writeMemoryEntry(options, { scope: 'self', title: 'methods', content: '不要只根据理论猜测' })
    const llm: LlmClient = {
      async chat(input) {
        calls++
        assert.equal(input.tools.length, 1)
        assert.equal(input.tools[0]!.name, 'memory_maintenance_result')
        assert.match(input.messages[0]!.content as string, /entry-1/)
        return {
          content: JSON.stringify({
            decision: 'mutate',
            reason: '三条线索属于同一种稳定排障方法',
            operations: [{
              action: 'merge',
              entryIds: ['entry-1', 'entry-2', 'entry-3'],
              content: '排障时先核对代码和实际日志，不只根据理论猜测。',
            }],
          }),
          toolCalls: [],
          usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 30 },
          model: 'mock',
        }
      },
    }
    const scheduler = createTaskScheduler({ maintenance: { concurrency: 1 } })
    const runtime = createMemoryMaintenanceRuntime({
      rootDir,
      llm,
      taskScheduler: scheduler,
      recentEntryThreshold: 3,
      recentCharThreshold: 10_000,
      id: () => 'stable-1',
      recordUsage() {},
    })

    runtime.enqueue('self/methods.md')
    await runtime.drain()
    const after = await inspectMemoryFileForMaintenance({ rootDir }, 'self/methods.md')

    assert.equal(calls, 1)
    assert.equal(after.recentCount, 0)
    assert.equal(after.stableCount, 1)
    assert.equal(after.entries[0]?.id, 'stable-1')
    assert.equal(after.entries[0]?.content, '排障时先核对代码和实际日志，不只根据理论猜测。')
  })

  test('coalesces the same active file and retries a revision conflict with fresh state', async () => {
    let calls = 0
    let nextId = 0
    const options = { rootDir, id: () => `entry-${++nextId}` }
    await writeMemoryEntry(options, { scope: 'self', title: 'methods', content: '线索一' })
    await writeMemoryEntry(options, { scope: 'self', title: 'methods', content: '线索二' })
    const llm: LlmClient = {
      async chat() {
        calls++
        if (calls === 1) {
          await writeMemoryEntry(options, { scope: 'self', title: 'methods', content: '并发写入的新线索' })
        }
        return {
          content: JSON.stringify({
            decision: 'mutate',
            reason: '合并稳定结论',
            operations: [{
              action: 'merge',
              entryIds: calls === 1 ? ['entry-1', 'entry-2'] : ['entry-1', 'entry-2', 'entry-3'],
              content: '已经整理后的稳定结论',
            }],
          }),
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
          model: 'mock',
        }
      },
    }
    const runtime = createMemoryMaintenanceRuntime({
      rootDir,
      llm,
      recentEntryThreshold: 2,
      recentCharThreshold: 10_000,
      id: () => 'stable-1',
      recordUsage() {},
    })

    const first = runtime.enqueue('self/methods.md')
    const second = runtime.enqueue('self/methods.md')
    assert.equal(first.coalesced, false)
    assert.equal(second.coalesced, true)
    await runtime.drain()
    const after = await inspectMemoryFileForMaintenance({ rootDir }, 'self/methods.md')

    assert.equal(calls, 2)
    assert.equal(after.stableCount, 1)
    assert.equal(after.recentCount, 0)
  })

  test('retries invalid reviewer output once and leaves memory unchanged', async () => {
    let calls = 0
    await writeMemoryEntry({ rootDir, id: () => 'entry-1' }, {
      scope: 'self', title: 'methods', content: '线索一',
    })
    await writeMemoryEntry({ rootDir, id: () => 'entry-2' }, {
      scope: 'self', title: 'methods', content: '线索二',
    })
    const before = await inspectMemoryFileForMaintenance({ rootDir }, 'self/methods.md')
    const llm: LlmClient = {
      async chat() {
        calls++
        return {
          content: '我觉得先等等',
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
          model: 'mock',
        }
      },
    }
    const runtime = createMemoryMaintenanceRuntime({
      rootDir,
      llm,
      recentEntryThreshold: 2,
      recordUsage() {},
    })

    runtime.enqueue('self/methods.md')
    await runtime.drain()
    const after = await inspectMemoryFileForMaintenance({ rootDir }, 'self/methods.md')

    assert.equal(calls, 2)
    assert.equal(after.revision, before.revision)
    assert.equal(after.recentCount, 2)
  })
})
