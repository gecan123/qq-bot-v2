import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMetricsTool } from './metrics.js'

test('metrics maps fixed actions to bounded daily metric options', async () => {
  const calls: unknown[] = []
  const tool = createMetricsTool({
    async load(options) {
      calls.push(options)
      return { timezone: 'Asia/Shanghai', generatedAt: 'now', reports: [] }
    },
  })

  await tool.execute({ action: 'yesterday' }, undefined as never)
  await tool.execute({ action: 'date', date: '2026-07-22' }, undefined as never)
  await tool.execute({ action: 'days', days: 3 }, undefined as never)

  assert.deepEqual(calls, [
    { endOffsetDays: -1 },
    { date: '2026-07-22' },
    { days: 3 },
  ])
})
