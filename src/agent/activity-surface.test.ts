import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ToolExecutor } from './tool.js'
import {
  createActivityTrackingToolExecutor,
  createAgentActivityReporter,
  type AgentActivitySurface,
} from './activity-surface.js'

const startedAt = new Date('2026-07-20T08:00:00.000Z')

describe('AgentActivityReporter', () => {
  test('publishes structured phases, trigger and wait state without losing the last completed action', async () => {
    let now = startedAt
    const writes: AgentActivitySurface[] = []
    const reporter = createAgentActivityReporter({
      path: '/tmp/agent-activity-test.json',
      pid: 123,
      instanceId: 'instance-1',
      now: () => now,
      write: async (_path, surface) => { writes.push(surface) },
    })

    reporter.setTrigger({
      kind: 'private_message',
      label: '收到 Alice 的私聊',
      target: { type: 'private', id: '42' },
    })
    reporter.setPhase({ phase: 'thinking', roundIndex: 7 })
    now = new Date('2026-07-20T08:00:03.000Z')
    reporter.setPhase({
      phase: 'waiting',
      roundIndex: 7,
      detail: '等待新消息或后台结果',
      waitUntil: '2026-07-20T08:15:03.000Z',
    })
    await reporter.flush()

    const surface = writes.at(-1)!
    assert.equal(surface.phase, 'waiting')
    assert.equal(surface.phaseStartedAt, '2026-07-20T08:00:03.000Z')
    assert.equal(surface.roundIndex, 7)
    assert.equal(surface.trigger?.kind, 'private_message')
    assert.equal(surface.trigger?.target?.id, '42')
    assert.equal(surface.waitUntil, '2026-07-20T08:15:03.000Z')
    assert.deepEqual(surface.activeTools, [])
  })

  test('tracks concurrent tools and returns to thinking after the final tool finishes', async () => {
    let now = startedAt
    const writes: AgentActivitySurface[] = []
    const pending = new Map<string, () => void>()
    const base: ToolExecutor = {
      list: () => [],
      classify: () => ({ sideEffect: false, concurrency: 'parallel' }),
      execute: async (call) => await new Promise((resolve) => {
        pending.set(call.id, () => resolve({ content: '{"ok":true}', outcome: { ok: true } }))
      }),
    }
    const reporter = createAgentActivityReporter({
      path: '/tmp/agent-activity-test.json',
      pid: 123,
      instanceId: 'instance-1',
      now: () => now,
      write: async (_path, surface) => { writes.push(surface) },
    })
    const tools = createActivityTrackingToolExecutor(base, reporter)
    const ctx = { eventQueue: {} as never, roundIndex: 4 }

    const first = tools.execute({ id: 'call-1', name: 'inbox', args: { action: 'read' } }, ctx)
    const second = tools.execute({ id: 'call-2', name: 'invoke', args: { tool: 'web_search', args: { query: 'BTC' } } }, ctx)
    await reporter.flush()
    assert.equal(writes.at(-1)?.phase, 'tool')
    assert.deepEqual(writes.at(-1)?.activeTools.map(tool => tool.toolName), ['inbox', 'web_search'])

    now = new Date('2026-07-20T08:00:02.000Z')
    pending.get('call-1')!()
    await first
    await reporter.flush()
    assert.equal(writes.at(-1)?.phase, 'tool')
    assert.deepEqual(writes.at(-1)?.activeTools.map(tool => tool.toolName), ['web_search'])

    now = new Date('2026-07-20T08:00:05.000Z')
    pending.get('call-2')!()
    await second
    await reporter.flush()
    const completed = writes.at(-1)!
    assert.equal(completed.phase, 'thinking')
    assert.deepEqual(completed.activeTools, [])
    assert.equal(completed.lastCompleted?.toolName, 'web_search')
    assert.equal(completed.lastCompleted?.ok, true)
    assert.equal(completed.lastCompleted?.durationMs, 5_000)
  })
})
